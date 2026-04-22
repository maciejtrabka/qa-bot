/**
 * PR browser agent: Stagehand (LOCAL) + OpenRouter. Optional PR context (pr-context/).
 * QA steps and pass/fail criteria come from a prompt file or PR_AGENT_PROMPT env.
 * Merge gate: structured verdict — qaPassed must be true.
 *
 * Verdict step uses a vision-capable LLM call by default (screenshots + a11y tree +
 * optional DOM text contrast heuristics + PR context), so the agent is likelier
 * to catch “invisible” copy (text color ≈ background, often paired with
 * `aria-hidden`). Disable vision with PR_AGENT_VISION=0; disable contrast with
 * PR_AGENT_CONTRAST_SCAN=0.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Stagehand } from "@browserbasehq/stagehand";
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:9333").replace(
  /\/$/,
  ""
);
const apiKey = process.env.OPENROUTER_API_KEY?.trim();
const modelName =
  process.env.STAGEHAND_MODEL?.trim() || "anthropic/claude-sonnet-4.6";

const visionEnabled =
  (process.env.PR_AGENT_VISION ?? "1").trim().toLowerCase() !== "0";

/**
 * How many independent LLM verdict passes to run with the same evidence
 * (screenshots + a11y tree + diagnostics prepared once). Conservative
 * aggregation: if ANY pass returns qaPassed=false, the gate fails and all
 * reported bugs are merged (deduped by title / anchorText). Default is 2 so the
 * gate is less sensitive to a single stochastic miss; can be overridden per
 * run, e.g. PR_AGENT_RUNS=1 locally while iterating on the prompt.
 */
const verdictRuns = (() => {
  const raw = (process.env.PR_AGENT_RUNS ?? "2").trim();
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 5);
})();

const viewportScreenshotPath =
  process.env.PR_AGENT_SCREENSHOT_VIEWPORT?.trim() ||
  "pr-agent-screenshot-viewport.png";
const fullPageScreenshotPath =
  process.env.PR_AGENT_SCREENSHOT_FULLPAGE?.trim() ||
  "pr-agent-screenshot-fullpage.png";

const failureLogPath = process.env.PR_AGENT_FAILURE_LOG ?? "pr-agent-failure.txt";

/** Where to dump the captured console/network diagnostics for the artifact. */
const diagnosticsLogPath =
  process.env.PR_AGENT_DIAGNOSTICS_LOG?.trim() || "pr-agent-diagnostics.txt";

/** JSON dump of DOM text contrast heuristics (for CI artifacts and debugging). */
const contrastLogPath = process.env.PR_AGENT_CONTRAST_LOG?.trim() || "pr-agent-contrast.json";

/** Set `0` to skip the in-page text contrast pass (faster, weaker on invisible text). */
const contrastScanEnabled =
  (process.env.PR_AGENT_CONTRAST_SCAN ?? "1").trim().toLowerCase() !== "0";

/**
 * When `1`, if the in-page pass finds any text/background pair with a WCAG
 * ratio below the strict threshold (same-color / invisible text), the gate
 * **fails** even if the model returned `qaPassed`. Default **off** so
 * existing pipelines are not surprised — set to `1` in repo Variables when
 * you want a hard fail for truly invisible text.
 */
const contrastStrictGateEnabled =
  (process.env.PR_AGENT_CONTRAST_STRICT ?? "0").trim().toLowerCase() === "1";

const contrastStrictMaxRatio = (() => {
  const raw = (process.env.PR_AGENT_CONTRAST_STRICT_MAX_RATIO ?? "1.08").trim();
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 1 || n > 1.2) return 1.08;
  return n;
})();

const contrastListMaxRatio = (() => {
  const raw = (process.env.PR_AGENT_CONTRAST_LIST_MAX_RATIO ?? "1.35").trim();
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 1) return 1.35;
  return n;
})();

const contrastMaxRows = (() => {
  const raw = (process.env.PR_AGENT_CONTRAST_MAX_ROWS ?? "35").trim();
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 35;
  return Math.min(n, 80);
})();

/** Short markdown for `gh pr comment` (written on failure; workflow reads this file). */
const prAgentPrCommentPath =
  process.env.PR_AGENT_PR_COMMENT_FILE?.trim() || "pr-agent-pr-comment.md";

// ----- Browser diagnostics (console capture) ---------------------------------
// Captures `console.error` / `console.warn` via Stagehand v3's CDP-backed
// console bridge (the only page-level event its public API exposes, see
// node_modules/@browserbasehq/stagehand/.../understudy/page.js → `on()`).
// Uncaught page errors and network-level events (failed requests, HTTP ≥ 400)
// are NOT captured here — Stagehand v3 doesn't expose those on the page, and
// we deliberately don't reach into its private CDP session. Those signals may
// still show up as `console.error` if the app logs them itself.

type ConsoleEntry = {
  kind: "console.error" | "console.warn";
  text: string;
};

const MAX_CONSOLE_ENTRIES = 30;

const consoleEntries: ConsoleEntry[] = [];

function pushCapped<T>(arr: T[], value: T, cap: number): void {
  arr.push(value);
  if (arr.length > cap) arr.shift();
}

/**
 * Attach a console listener via Stagehand's page bridge and record
 * `console.error` / `console.warn` entries. Call this BEFORE `page.goto(...)`
 * so that load-time errors are also captured.
 */
function attachDiagnosticsListeners(page: unknown): void {
  type PageLike = {
    on: (event: string, handler: (...args: unknown[]) => void) => unknown;
  };
  const p = page as PageLike;

  try {
    p.on("console", (msg: unknown) => {
      try {
        const m = msg as { type?: () => string; text?: () => string };
        const type = m.type?.();
        if (type !== "error" && type !== "warning") return;
        const text = String(m.text?.() ?? "").slice(0, 500);
        if (!text) return;
        pushCapped(
          consoleEntries,
          {
            kind: type === "error" ? "console.error" : "console.warn",
            text,
          },
          MAX_CONSOLE_ENTRIES
        );
      } catch {
        /* best-effort */
      }
    });
  } catch (e) {
    console.warn("attachDiagnosticsListeners: could not subscribe to console", e);
  }
}

function formatDiagnosticsBlock(): string {
  if (consoleEntries.length === 0) {
    return [
      "## Console capture",
      "",
      "No `console.error` / `console.warn` entries were captured during this run.",
      "",
      "_Note: only browser console is tapped. Uncaught page exceptions and network failures are not captured here — infer those only if they surface as explicit `console.error` messages._",
    ].join("\n");
  }

  const lines: string[] = ["## Console capture", ""];

  for (const e of consoleEntries) {
    lines.push(`- [${e.kind}] ${e.text}`);
  }

  lines.push("");
  lines.push(
    "_Note: only browser console is tapped. Uncaught page exceptions and network failures are not captured here — infer those only if they surface as explicit `console.error` messages above._"
  );

  return lines.join("\n");
}

// ----- DOM text contrast (WCAG luminance, no LLM) ---------------------------
// Surfaces text whose foreground/resolved background ratio is near 1.0 even
// when screenshots look “empty” and the a11y tree omits `aria-hidden` content.

type ContrastFinding = {
  textSnippet: string;
  contrastRatio: number;
  fg: string;
  bg: string;
  selectorHint: string;
  ariaHidden: boolean;
  tag: string;
};

type ContrastScanResult = {
  findings: ContrastFinding[];
  strictHits: ContrastFinding[];
};

type PageEval = {
  evaluate: <R, A>(pageFunction: (arg: A) => R, arg: A) => Promise<R>;
};

/**
 * In-page pass: text nodes, computed `color` vs effective opaque background
 * (walks ancestors). Injects one JSON row per low-contrast case for the
 * verdict prompt. Best-effort only — gradients/images are not modeled.
 */
async function runDomTextContrastScan(page: unknown): Promise<ContrastScanResult | null> {
  if (!contrastScanEnabled) {
    return null;
  }
  const p = page as PageEval;
  if (typeof p.evaluate !== "function") {
    console.warn("runDomTextContrastScan: page.evaluate is not available; skipping.");
    return null;
  }
  try {
    const listMax = contrastListMaxRatio;
    const maxRows = contrastMaxRows;
    const data = (await p.evaluate(
      (opts: { listMax: number; maxRows: number }) => {
        const listMaxI = opts.listMax;
        const cap = opts.maxRows;
        const gcs = (el: Element) => window.getComputedStyle(el);
        const bgStr = (rgb: { r: number; g: number; b: number }) => `rgb(${Math.round(rgb.r)},${Math.round(rgb.g)},${Math.round(rgb.b)})`;

        function parseRgbToRgba(
          s: string
        ): { r: number; g: number; b: number; a: number } | null {
          const t = s.trim();
          if (t === "transparent" || t === "rgba(0, 0, 0, 0)" || t === "rgba(0,0,0,0)")
            return null;
          const m = t.match(
            /^rgba?\s*\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/i
          );
          if (!m) return null;
          return {
            r: Math.min(255, Math.max(0, +m[1])),
            g: Math.min(255, Math.max(0, +m[2])),
            b: Math.min(255, Math.max(0, +m[3])),
            a: m[4] === undefined ? 1 : Math.min(1, Math.max(0, +m[4])),
          };
        }

        function srgbToLin(u: number): number {
          const c = u / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        }

        function relLum(rgb: { r: number; g: number; b: number }): number {
          const r = srgbToLin(rgb.r);
          const g = srgbToLin(rgb.g);
          const b = srgbToLin(rgb.b);
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }

        function contrastRatio(L1: number, L2: number): number {
          return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        }

        function resolveOpaqueBackground(el: Element | null): { r: number; g: number; b: number } {
          let n: Element | null = el;
          for (let depth = 0; n && depth < 40; n = n.parentElement, depth += 1) {
            const bg = parseRgbToRgba(gcs(n).backgroundColor);
            if (bg && bg.a > 0.9) {
              return { r: bg.r, g: bg.g, b: bg.b };
            }
          }
          return { r: 255, g: 255, b: 255 };
        }

        function selectorHint(el: Element): string {
          if (el.id) return `${el.tagName.toLowerCase()}#${el.id.slice(0, 80)}`;
          const cl =
            el instanceof HTMLElement && el.className && typeof el.className === "string"
              ? el.className
                  .trim()
                  .split(/\s+/)
                  .filter(Boolean)
                  .slice(0, 2)
              : [];
          if (cl.length) return `${el.tagName.toLowerCase()}.${cl.join(".")}`;
          return el.tagName.toLowerCase();
        }

        const raw: Array<{
          textSnippet: string;
          contrastRatio: number;
          fg: string;
          bg: string;
          selectorHint: string;
          ariaHidden: boolean;
          tag: string;
        }> = [];

        const walk = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: (node) => {
              const t = (node as Text).data?.replace(/\s+/g, " ").trim() ?? "";
              if (t.length < 3) return NodeFilter.FILTER_REJECT;
              const par = (node as Text).parentElement;
              if (!par) return NodeFilter.FILTER_REJECT;
              const name = par.nodeName.toLowerCase();
              if (name === "script" || name === "style" || name === "noscript") {
                return NodeFilter.FILTER_REJECT;
              }
              return NodeFilter.FILTER_ACCEPT;
            },
          }
        );

        const seen = new Set<string>();
        const root = document.documentElement;
        for (;;) {
          const n = walk.nextNode() as Text | null;
          if (!n) break;
          const el = n.parentElement;
          if (!el) continue;
          if (!root.contains(el)) continue;
          const textSnippet = n.data?.replace(/\s+/g, " ").trim() ?? "";
          if (textSnippet.length < 3 || textSnippet.length > 140) continue;

          const cs = gcs(el);
          if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity < 0.05) {
            continue;
          }
          const r = el.getBoundingClientRect();
          if (r.width < 1 && r.height < 1) continue;
          if (r.bottom < 0 || r.right < 0) continue;

          const fc = parseRgbToRgba(cs.color);
          if (!fc || fc.a < 0.08) continue;
          const fgL = relLum({ r: fc.r, g: fc.g, b: fc.b });
          const brgb = resolveOpaqueBackground(el);
          const bgL = relLum(brgb);
          const ratio = contrastRatio(fgL, bgL);

          if (ratio > listMaxI) continue;
          if (textSnippet.length > 120) continue;
          const key = `${selectorHint(el)}|${textSnippet.slice(0, 60)}|${Math.round(ratio * 1000)}`;
          if (seen.has(key)) continue;
          seen.add(key);

          raw.push({
            textSnippet: textSnippet,
            contrastRatio: Math.round(ratio * 1000) / 1000,
            fg: cs.color,
            bg: bgStr(brgb),
            selectorHint: selectorHint(el),
            ariaHidden: el.closest("[aria-hidden='true']") != null,
            tag: el.tagName.toLowerCase(),
          });
          if (raw.length > cap * 2) {
            /* avoid pathological pages */
            break;
          }
        }

        raw.sort((a, b) => a.contrastRatio - b.contrastRatio);
        return raw.slice(0, cap);
      },
      { listMax: listMax, maxRows: maxRows }
    )) as ContrastFinding[];

    const list = data ?? [];
    const strictHits = list.filter((f) => f.contrastRatio < contrastStrictMaxRatio);

    return { findings: list, strictHits };
  } catch (e) {
    console.warn("runDomTextContrastScan failed:", e);
    return { findings: [], strictHits: [] };
  }
}

function formatContrastBlockForPrompt(scan: ContrastScanResult | null): string {
  if (!scan) {
    return [
      "## DOM text contrast (machine check)",
      "",
      "Contrast pass was not run (disabled or not supported on this `page`).",
      "",
    ].join("\n");
  }
  if (scan.findings.length === 0) {
    return [
      "## DOM text contrast (machine check)",
      "",
      "No in-document text runs had an unusually low foreground/background ratio in this snapshot.",
      "",
    ].join("\n");
  }

  const lines: string[] = [
    "## DOM text contrast (machine check)",
    "",
    "These rows were computed in the real browser: **text node → computed `color` → nearest opaque `background-color` up the tree**, then a WCAG-style contrast ratio (1.0 = same luminance, effectively invisible; higher is more readable).",
    "",
    "**`ariaHidden: true`** here means a parent has `aria-hidden=\"true\"`, so the accessibility snapshot may **omit** this string even though the pixels look blank — do not assume “no text” from the a11y tree alone for this case.",
    "",
    "### How to use this in your verdict (STRICT for the PR change region)",
    "",
    "- If a row is **in the PR change region** (touched file / section implied by the diff) and the ratio is **1.0–1.1** (or the row is clearly “same as background” even at ~1.15), treat it as a **BLOCKING** visual issue: the copy is not readable, even if the attached screenshots do not show letter shapes. Report it in `bugs[]` with `kind: 'visual'`.",
    "- For `anchorText` when the sentence is not drawn visibly: use a **visible, stable** label in the same card or column (a heading, section title, or `POPULAR TAGS`-style label) and quote the **exact `textSnippet` from this table** in `expectedResult` / `actualResult` or `notes`.",
    "- Do **not** report rows that are clearly **outside** the diff’s UI scope (ignore decorative site-wide content unrelated to the change).",
    "- Do **not** use this table alone to claim something is “in the diff” if the path/class is nowhere in the PR file list; scope still comes from the PR context.",
    "",
  ];

  lines.push("ratio | textSnippet | fg | bg | selector | ariaHidden");
  for (const f of scan.findings) {
    const a = f.ariaHidden ? "yes" : "no";
    const snip = f.textSnippet.replace(/`/g, "'").replace(/\s+/g, " ").trim();
    lines.push(
      `${f.contrastRatio} | ${snip.slice(0, 100)} | ${f.fg} | ${f.bg} | \`${f.selectorHint}\` | ${a} (${f.tag})`
    );
  }
  lines.push("");
  return lines.join("\n");
}

function makeSyntheticContrastBugs(
  strictHits: ContrastFinding[]
): { bugs: Bug[]; summary: string } {
  if (strictHits.length === 0) {
    return { bugs: [], summary: "" };
  }
  const first = strictHits[0]!;
  const allSnips = strictHits
    .map((h) => `"${h.textSnippet.replace(/\s+/g, " ").slice(0, 200)}"`)
    .join("; ");
  const anchor = first.textSnippet.replace(/\s+/g, " ").trim().slice(0, 120);
  const b: Bug = {
    title: "Text/background contrast is effectively 1:1 in the preview (invisible or unreadable copy)",
    kind: "visual",
    stepsToReproduce: [
      "Open the PR preview and scroll the region containing the table entry below.",
      "Optionally use devtools to read computed `color` and `background-color` for the same element — they match the machine row.",
    ],
    expectedResult: "Intended help or hint text must be visible (readable against its surface), not equal to the background in luminance for normal readers.",
    actualResult: `Computed WCAG-style contrast is ~${first.contrastRatio} for: ${allSnips}. The snapshot machine-check lists the exact foreground, background, and hint selector.`,
    notes:
      "Raised by PR_AGENT_CONTRAST_STRICT (deterministic) because at least one text/background pair had a near-1.0 ratio.",
    anchorText: anchor.length >= 2 ? anchor : `div.${first.tag}`,
    anchorHint: "invisible or same-as-background text from DOM contrast list; crop may look like an empty area",
  };
  return { bugs: [b], summary: b.title };
}

function applyContrastStrictGate(
  verdict: Verdict,
  scan: ContrastScanResult | null
): Verdict {
  if (!contrastStrictGateEnabled || !scan || scan.strictHits.length === 0) {
    return verdict;
  }
  if (!verdict.qaPassed) {
    return verdict;
  }
  const { bugs, summary } = makeSyntheticContrastBugs(scan.strictHits);
  if (bugs.length === 0) return verdict;
  return {
    ...verdict,
    qaPassed: false,
    whatYouChecked: [summary, verdict.whatYouChecked].filter(Boolean).join(" — ").slice(0, 400),
    bugs: [...bugs, ...(verdict.bugs ?? [])],
  };
}

const contextDir = (process.env.PR_AGENT_CONTEXT_DIR ?? "pr-context").replace(
  /\/$/,
  ""
);

const promptFile =
  process.env.PR_AGENT_PROMPT_FILE?.trim() || "pr-agent-qa-prompt.md";

const MAX_INLINE_PROMPT = 48_000;
const MAX_ACT_PROMPT = 95_000;

const bugSchema = z.object({
  title: z
    .string()
    .describe(
      "One-line title of this specific bug (e.g. 'Increment (+) button has no effect on click')."
    ),
  stepsToReproduce: z
    .array(z.string())
    .describe("1–5 imperative steps, each a short sentence (English)."),
  expectedResult: z
    .string()
    .describe("What should happen (English, one or two short sentences)."),
  actualResult: z
    .string()
    .describe("What actually happened (English, one or two short sentences)."),
  notes: z
    .string()
    .nullish()
    .describe("Optional short non-blocking context for this bug only."),
  kind: z
    .enum(["visual", "functional"])
    .nullish()
    .describe(
      "Bug category. 'visual' = screenshot-only regression (invisible/illegible text, hidden/obscured controls, broken layout). 'functional' = behavior/logic/state/network regression. Omit = treated as 'functional'."
    ),
  anchorText: z
    .string()
    .nullish()
    .describe(
      "REQUIRED when kind='visual'. For kind='functional', optional but strongly preferred when any stable visible label/text exists near the defect — it is used to locate the element for a cropped pr-agent-bug-*.png. A short, distinctive fragment of visible text taken verbatim from (or immediately next to) the affected element as it appears on the screenshot. Used only to locate the element for cropped evidence — never invent text, only quote what is actually rendered."
    ),
  anchorHint: z
    .string()
    .nullish()
    .describe(
      "Optional free-form hint to disambiguate anchorText when it could match several places (e.g. 'card in bottom-right', 'third button in the header row'). English, short."
    ),
});

const verdictSchema = z.object({
  qaPassed: z
    .boolean()
    .describe(
      "true only if every blocking criterion from the QA instructions is satisfied"
    ),
  /** One short English sentence: what behavior you verified in the PR change region (not a list of pages, routes, or nav items visited). */
  whatYouChecked: z.string(),
  /**
   * When qaPassed is false: one entry per blocking bug (English, fully structured).
   * Every blocking finding MUST be represented as its own bug object here —
   * do not merge multiple bugs into one, and do not leave some bugs only as plain bullets.
   */
  bugs: z.array(bugSchema).nullish(),
  /** Optional non-blocking context that is not tied to a specific bug (English). */
  notes: z.string().nullish(),

  // ----- Legacy fields (back-compat with older model responses; migrated at render time) -----
  /** @deprecated — prefer bugs[].title. Retained so older responses still render. */
  headline: z.string().nullish(),
  /** @deprecated — prefer bugs[].stepsToReproduce. */
  stepsToReproduce: z.array(z.string()).nullish(),
  /** @deprecated — prefer bugs[].expectedResult. */
  expectedResult: z.string().nullish(),
  /** @deprecated — prefer bugs[].actualResult. */
  actualResult: z.string().nullish(),
  /** @deprecated — prefer bugs[]. */
  blockingFindings: z.array(z.string()).nullish(),
});

type Bug = z.infer<typeof bugSchema>;
type Verdict = z.infer<typeof verdictSchema>;

/**
 * Result of running the verdict LLM `runsTotal` times over the same evidence,
 * after aggregation. `runsFlagged` is how many runs returned `qaPassed=false`
 * (useful metadata for the PR comment — a 1/2 or 2/2 split tells the reviewer
 * whether the gate was unanimous or borderline). The merged `verdict` follows
 * the conservative rule: any fail wins.
 */
type VerdictBundle = {
  verdict: Verdict;
  runsTotal: number;
  runsFlagged: number;
};

type QaEnvironment = {
  previewUrl: string;
  userAgent: string;
  runTimeUtc: string;
};

type PrContextMaterial = {
  title: string;
  body: string;
  changedFiles: string;
  diffPatch: string;
};

function loadPrContext(): PrContextMaterial | null {
  const prJsonPath = join(contextDir, "pr.json");
  if (!existsSync(prJsonPath)) {
    return null;
  }

  let title = "";
  let body = "";
  try {
    const raw = readFileSync(prJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { title?: unknown; body?: unknown };
    title = typeof parsed.title === "string" ? parsed.title : "";
    body = typeof parsed.body === "string" ? parsed.body : "";
  } catch (e) {
    console.warn("pr-context/pr.json parse failed:", e);
    return null;
  }

  const filesPath = join(contextDir, "files.txt");
  let changedFiles = "";
  if (existsSync(filesPath)) {
    changedFiles = readFileSync(filesPath, "utf8").trim();
    if (changedFiles.length > 8000) {
      changedFiles = `${changedFiles.slice(0, 8000)}\n\n[… files list truncated …]`;
    }
  }

  const diffPath = join(contextDir, "diff.patch");
  let diffPatch = "";
  if (existsSync(diffPath)) {
    diffPatch = readFileSync(diffPath, "utf8");
    const maxDiff = 28_000;
    if (diffPatch.length > maxDiff) {
      diffPatch = `${diffPatch.slice(0, maxDiff)}\n\n[… diff truncated for prompt size …]`;
    }
  }

  const maxBody = 6000;
  if (body.length > maxBody) {
    body = `${body.slice(0, maxBody)}\n\n[… PR body truncated …]`;
  }

  return { title, body, changedFiles, diffPatch };
}

function formatPrContextForPrompt(ctx: PrContextMaterial | null): string {
  if (!ctx) {
    return [
      "PR context: none (no pr-context/pr.json — e.g. local run or workflow_dispatch).",
      "Follow the QA instructions: infer a reasonable change region from what you can see; test that area deeply; do not treat this as full-site regression.",
    ].join("\n");
  }

  const diffFence =
    ctx.diffPatch.length > 0 ? ctx.diffPatch : "(no diff text)";

  return [
    "## Pull request context (author intent + scope)",
    "",
    `**Title:** ${ctx.title || "(empty)"}`,
    "",
    "**Description:**",
    ctx.body || "(empty)",
    "",
    "**Changed files (paths):**",
    ctx.changedFiles || "(none listed)",
    "",
    "**Patch (truncated):**",
    "```diff",
    diffFence,
    "```",
  ].join("\n");
}

function trimForPrComment(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

/** How many consecutive pr-agent-bug-<n>.png files exist on disk (best-effort). */
function countBugEvidencePngs(): number {
  let n = 0;
  for (let i = 1; i <= 32; i++) {
    if (existsSync(`pr-agent-bug-${i}.png`)) n = i;
    else break;
  }
  return n;
}

type PrArtifactSnapshot = {
  savedViewport: boolean;
  savedFullPage: boolean;
  bugEvidenceFiles: number;
};

/**
 * Footer for the PR comment: screenshots are never inlined on GitHub — they live in
 * the same workflow artifact as text logs (`pr-agent-logs`).
 */
function buildPrArtifactFooter(snapshot?: PrArtifactSnapshot): string {
  const base =
    "**Screenshots & logs:** Files `pr-agent-screenshot-viewport.png`, `pr-agent-screenshot-fullpage.png`, and any `pr-agent-bug-*.png` are **not** embedded in this comment — they are uploaded with `pr-agent.log` and related text in workflow artifact **`pr-agent-logs`**. Download **pr-agent-logs** from this workflow run (Actions) to open the PNGs.";
  if (!snapshot) {
    return `<sub>${base}</sub>`;
  }
  const parts: string[] = [];
  if (snapshot.savedViewport) parts.push("viewport screenshot");
  if (snapshot.savedFullPage) parts.push("full-page screenshot");
  if (snapshot.bugEvidenceFiles > 0) {
    parts.push(`${snapshot.bugEvidenceFiles} bug evidence PNG(s)`);
  }
  const tail =
    parts.length > 0 ? ` **Written this run:** ${parts.join("; ")}.` : "";
  return `<sub>${base}${tail}</sub>`;
}

function writePrFailureComment(markdown: string): void {
  const max = 6000;
  const out =
    markdown.length > max ? `${markdown.slice(0, max)}\n\n[truncated]` : markdown;
  writeFileSync(prAgentPrCommentPath, out, "utf8");
}

const DEFAULT_EXPECTED =
  "Per the QA instructions: behavior in the PR change region matches intent; interactions there work as expected where the change applies.";

/**
 * Normalize a verdict into a list of fully-structured bugs. Prefers the new
 * `bugs[]` field; falls back to legacy single-bug fields + `blockingFindings`
 * so older model responses still render cleanly.
 */
function collectBugs(verdict: Verdict): Bug[] {
  const fromBugs = (verdict.bugs ?? [])
    .map((b) => ({
      title: b.title?.trim() ?? "",
      stepsToReproduce: (b.stepsToReproduce ?? [])
        .map((s) => s.trim())
        .filter(Boolean),
      expectedResult: b.expectedResult?.trim() ?? "",
      actualResult: b.actualResult?.trim() ?? "",
      notes: b.notes?.trim() || undefined,
      kind: b.kind ?? undefined,
      anchorText: b.anchorText?.trim() || undefined,
      anchorHint: b.anchorHint?.trim() || undefined,
    }))
    .filter((b) => b.title || b.actualResult || b.stepsToReproduce.length > 0);

  if (fromBugs.length > 0) {
    return fromBugs;
  }

  const legacyFindings = (verdict.blockingFindings ?? [])
    .map((s) => s.trim())
    .filter(Boolean);

  const legacyTitle =
    verdict.headline?.trim() ||
    legacyFindings[0] ||
    trimForPrComment(verdict.whatYouChecked, 220);

  const legacySteps = (verdict.stepsToReproduce ?? [])
    .map((s) => s.trim())
    .filter(Boolean);

  const legacyExpected = verdict.expectedResult?.trim() || "";
  const legacyActual =
    verdict.actualResult?.trim() ||
    legacyFindings.find((f) => f !== legacyTitle) ||
    legacyFindings[0] ||
    verdict.whatYouChecked.trim();

  const primary: Bug = {
    title: legacyTitle,
    stepsToReproduce: legacySteps,
    expectedResult: legacyExpected,
    actualResult: legacyActual,
  };

  const extras: Bug[] = legacyFindings
    .filter((f) => f !== legacyTitle && f !== legacyActual)
    .map((f) => ({
      title: trimForPrComment(f, 120),
      stepsToReproduce: [],
      expectedResult: "",
      actualResult: f,
    }));

  return [primary, ...extras];
}

/** Double horizontal rule with blank line in between (visually stronger separator). */
const DOUBLE_HR = ["---", "", "---", ""];

function renderBugSection(bug: Bug, index: number): string[] {
  const title = bug.title || `Blocking issue #${index + 1}`;
  const steps =
    bug.stepsToReproduce.length > 0
      ? bug.stepsToReproduce.slice(0, 5)
      : [
          "Open the preview at the workflow `BASE_URL`.",
          "Navigate only as needed to reach the UI region affected by the PR.",
          "Exercise the relevant controls there and observe results.",
        ];
  const expected = bug.expectedResult || DEFAULT_EXPECTED;
  const actual = trimForPrComment(bug.actualResult || "(not reported)", 520);

  const out: string[] = [
    `### Bug ${index + 1}: ${trimForPrComment(title, 200)}`,
    "",
    "**Steps to reproduce**",
    "",
    ...steps.map((s, i) => `${i + 1}. ${trimForPrComment(s, 320)}`),
    "",
    "**Expected result**",
    "",
    expected,
    "",
    "**Actual result**",
    "",
    actual,
    "",
  ];

  if (bug.notes) {
    out.push("**Notes**", "", trimForPrComment(bug.notes, 400), "");
  }

  return out;
}

function renderEnvironmentSection(
  env: QaEnvironment,
  runs?: { runsTotal: number; runsFlagged: number }
): string[] {
  const lines = [
    "### Environment",
    "",
    `- **Browser:** ${trimForPrComment(env.userAgent || "(unknown)", 240)}`,
    `- **Run time (UTC):** ${env.runTimeUtc}`,
  ];
  if (runs && runs.runsTotal > 1) {
    lines.push(
      `- **Verdict passes:** ${runs.runsFlagged}/${runs.runsTotal} flagged blocking issues (conservative aggregation: any fail blocks merge).`
    );
  } else if (runs && runs.runsTotal === 1) {
    lines.push(`- **Verdict passes:** 1 (single pass; set \`PR_AGENT_RUNS\` to raise).`);
  }
  lines.push("");
  return lines;
}

function formatQaVerdictComment(
  verdict: Verdict,
  env: QaEnvironment,
  evidence: Array<{ index: number; file: string }> = [],
  runs?: { runsTotal: number; runsFlagged: number },
  artifactSnapshot?: PrArtifactSnapshot
): string {
  const bugs = collectBugs(verdict);
  const notes = verdict.notes?.trim()
    ? trimForPrComment(verdict.notes.trim(), 280)
    : "";

  const evidenceByBug = new Map<number, string>();
  for (const e of evidence) {
    if (e?.file && Number.isInteger(e.index)) {
      evidenceByBug.set(e.index, e.file);
    }
  }

  const parts: string[] = [
    "### PR gate failed",
    "",
    "`pr_browser_agent` — **`qaPassed: false`**",
    "",
    "#### Bugs found",
    "",
  ];

  if (bugs.length > 0) {
    for (const b of bugs) {
      const t = b.title || "(untitled issue)";
      parts.push(`- ${trimForPrComment(t, 180)}`);
    }
  } else {
    parts.push(
      `- ${trimForPrComment(verdict.whatYouChecked || "Unspecified blocking issue", 180)}`
    );
  }
  parts.push("");

  bugs.forEach((bug, i) => {
    parts.push(...DOUBLE_HR, ...renderBugSection(bug, i));
    const file = evidenceByBug.get(i + 1);
    if (file) {
      parts.push(
        "",
        `> Visual evidence: \`${file}\` — same workflow artifact **pr-agent-logs** as the viewport/full-page PNGs (not inlined in this comment).`,
        ""
      );
    }
  });

  parts.push(...DOUBLE_HR, ...renderEnvironmentSection(env, runs));

  if (notes) {
    parts.push(...DOUBLE_HR, "### Notes", "", notes, "");
  }

  parts.push("---", "", buildPrArtifactFooter(artifactSnapshot));

  return parts.join("\n");
}

async function safeGetUserAgent(page: unknown): Promise<string> {
  try {
    const p = page as {
      evaluate?: (fn: () => string) => Promise<string>;
    };
    if (typeof p.evaluate === "function") {
      const ua = await p.evaluate(() => navigator.userAgent);
      if (typeof ua === "string" && ua.trim()) return ua.trim();
    }
  } catch (e) {
    console.warn("safeGetUserAgent failed:", e);
  }
  return "(unknown — could not read navigator.userAgent)";
}

function firstMeaningfulFailureLine(detail: string): string {
  const head = detail.split(/\n\s*at\s+/m)[0] ?? detail;
  const line = head.split("\n").find((l) => l.trim())?.trim() ?? "Unknown error";
  return trimForPrComment(line, 500);
}

function formatGenericFailureComment(summary: string): string {
  const snapshot: PrArtifactSnapshot = {
    savedViewport: existsSync(viewportScreenshotPath),
    savedFullPage: existsSync(fullPageScreenshotPath),
    bugEvidenceFiles: countBugEvidencePngs(),
  };
  const hasAnyArtifactFile =
    snapshot.savedViewport ||
    snapshot.savedFullPage ||
    snapshot.bugEvidenceFiles > 0;
  return [
    "### PR gate failed",
    "",
    "The QA step did not complete (tool/API error or unexpected response).",
    "",
    "**Summary:**",
    summary,
    "",
    "---",
    "",
    buildPrArtifactFooter(hasAnyArtifactFile ? snapshot : undefined),
  ].join("\n");
}

/** Extra paragraphs appended to pr-agent-failure.txt (diagnostics for humans / artifact). */
function appendFailureDiagnostics(detail: string): string {
  const lower = detail.toLowerCase();
  const sections: string[] = [];

  const isQaVerdict =
    detail.includes("QA gate failed") || detail.includes("qaPassed=false");

  // Avoid matching line:column like `file.ts:429:10` with a bare `\b429\b`.
  const looksRateLimited =
    /\bstatus\s*code\s*:\s*429\b/i.test(detail) ||
    /\bhttp\/\d(?:\.\d)?\s+429\b/i.test(detail) ||
    /"code"\s*:\s*429\b/.test(detail) ||
    lower.includes("rate limit") ||
    lower.includes("ratelimit") ||
    lower.includes("too many requests") ||
    lower.includes("resource_exhausted");

  if (looksRateLimited && !isQaVerdict) {
    sections.push(
      "",
      "## Hint (API rate limit)",
      "",
      "Logs suggest **HTTP 429 / rate limit** or an equivalent **too many requests** message.",
      "This is usually **provider throughput or quota** (e.g. OpenRouter), often on **free or cheap models** — it does **not** by itself mean the PR change is wrong.",
      "Next: wait and **re-run the workflow**, consider a **paid plan / different model** (`STAGEHAND_MODEL`), or **retry with backoff** in CI."
    );
  }

  const looksInfra =
    !isQaVerdict &&
    !looksRateLimited &&
    (lower.includes("provider returned error") ||
      lower.includes("invalid json response") ||
      lower.includes("ai_retryerror") ||
      lower.includes("econnreset") ||
      lower.includes("etimedout"));

  if (looksInfra) {
    sections.push(
      "",
      "## Hint (LLM infrastructure)",
      "",
      "This looks like an **API refusal or malformed response** (not a QA verdict from the prompt).",
      "Check OpenRouter status, account limits, and model settings; re-run — this **may not** indicate a UI regression."
    );
  }

  if (sections.length === 0) {
    return detail;
  }
  return `${detail.trimEnd()}\n${sections.join("\n")}\n`;
}

function loadQaPrompt(): string {
  const fromEnv = process.env.PR_AGENT_PROMPT?.trim();
  if (fromEnv) {
    const s =
      fromEnv.length > MAX_INLINE_PROMPT
        ? `${fromEnv.slice(0, MAX_INLINE_PROMPT)}\n\n[… PR_AGENT_PROMPT truncated …]`
        : fromEnv;
    console.log("QA prompt: from PR_AGENT_PROMPT env", `(${s.length} chars)`);
    return s;
  }

  if (!existsSync(promptFile)) {
    throw new Error(
      `Missing QA prompt: set PR_AGENT_PROMPT or add file "${promptFile}" (see pr-agent-qa-prompt.md in repo).`
    );
  }

  let text = readFileSync(promptFile, "utf8").trim();
  if (!text) {
    throw new Error(`QA prompt file "${promptFile}" is empty.`);
  }
  if (text.length > MAX_INLINE_PROMPT) {
    text = `${text.slice(0, MAX_INLINE_PROMPT)}\n\n[… prompt file truncated …]`;
  }
  console.log("QA prompt: from file", promptFile, `(${text.length} chars)`);
  return text;
}

function buildActInstruction(
  prCtxBlock: string,
  qaPrompt: string,
  origin: string
): string {
  const core = [
    prCtxBlock,
    "",
    "## QA instructions (your task — follow carefully)",
    "",
    qaPrompt,
    "",
    `**Origin:** only **${origin}**. Do not open other sites or new tabs.`,
    "",
    "**Change-focused QA:** Infer the **smallest UI/behavior region** implied by changed paths + diff + PR description. Navigate **only as needed** to reach that region. Test **intensely inside that region** (multiple meaningful checks). **Do not** perform full-app regression or systematically visit every nav item unless the diff touches shared shell/layout and the QA instructions require a few representative surfaces.",
    "",
    "**Verdict wording:** In `whatYouChecked`, summarize **what behavior** you verified in the PR scope — **not** a list of pages, routes, or tabs visited.",
  ].join("\n");

  if (core.length > MAX_ACT_PROMPT) {
    return `${core.slice(0, MAX_ACT_PROMPT)}\n\n[… act instruction truncated …]`;
  }
  return core;
}

function buildVerdictPrompt(
  prCtxBlock: string,
  qaPrompt: string,
  pageText: string | undefined,
  hasScreenshots: boolean,
  contrastBlock: string,
  diagnosticsBlock: string
): string {
  const parts: string[] = [
    prCtxBlock,
    "",
    "## QA instructions (same as for actions)",
    qaPrompt,
    "",
  ];

  if (hasScreenshots) {
    parts.push(
      "## Visual evidence",
      "",
      "Screenshots of the live preview page are attached below this text (viewport and/or full-page).",
      "",
      "**Use the screenshots as the primary source of truth** for anything visual: readable text, visible controls, color contrast, overlapping elements, empty areas where content should appear, hidden/invisible text or buttons (e.g., text with the same color as its background). The DOM/a11y tree cannot express these things.",
      "",
      "Also consider the accessibility-tree text snapshot below for labels, values, and structural context.",
      "",
      "### Evidence rules for visual claims (STRICT)",
      "",
      "- Any visual issue you report — in `bugs[]`, in a bug's `notes`, or in the top-level `notes` — MUST be anchored to a concrete observation on the attached screenshots: say what you actually see (or what is missing) in a specific region (e.g. 'the strip under the counter shows no hint text', 'the label blends into the card background and is unreadable', 'the button overlaps the badge'). **Exception:** the **DOM text contrast (machine check)** section may list a run with a near-1.0 ratio and `ariaHidden: yes` — the screenshot can look like a blank strip; for that, you may still file a **blocking** visual bug in the PR scope and cite the table row. Use a **visible** nearby heading or label for `anchorText` if the problem string is not readable in the PNG.",
      "- A CSS rule or a diff hunk is NOT visual evidence on its own. If the diff hints at a visual problem but the screenshots do not show it, state that explicitly: write 'diff hypothesis, not visually confirmed' and do NOT use hedged wording like 'may cause', 'might', 'could'.",
      "- If an element is present in the accessibility/DOM snapshot but is not visible on the screenshots (same color as its background, `visibility: hidden`, `opacity: 0`, clipped off-frame, covered by another element) AND it sits inside the PR change region, treat it as a BLOCKING visual bug on par with a broken handler. Create a dedicated entry in `bugs[]` for it; do not demote it to `notes`.",
      "- Low contrast also counts as a visual bug. 'Visible' is NOT automatically 'readable'. If text inside the PR change region is technically present on the screenshots but its contrast against the background is so low that the text is UNREADABLE, or CLEARLY LESS READABLE than the equivalent element in the same section / sibling components of the same type (e.g., placeholders in the other demo cards, labels in the other buttons, descriptions in the other list rows), treat it as a BLOCKING visual bug with its own entry in `bugs[]`. In `actualResult`, spell out the COMPARISON: what is unreadable, and what you are comparing it to (e.g., 'the placeholder on the FX card is barely distinguishable from the card background, while placeholders on the Weather / Cat / Slots cards are clearly readable muted gray text'). 'Readable' means recognizable at a glance — NOT 'I managed to make out the letters after staring at it'.",
      "- Evidence rules apply only inside the PR change region; do not expand scope to the rest of the site.",
      ""
    );
  } else {
    parts.push(
      "## Evidence",
      "",
      "No screenshots are attached for this run — rely on the **DOM text contrast (machine check)** (when present), the PR context, and the accessibility/page text snapshot. Scope findings to the PR change region.",
      ""
    );
  }

  if (contrastBlock.trim().length > 0) {
    parts.push(contrastBlock, "");
  }

  if (pageText && pageText.trim().length > 0) {
    const MAX_PAGE_TEXT = 20_000;
    const snippet =
      pageText.length > MAX_PAGE_TEXT
        ? `${pageText.slice(0, MAX_PAGE_TEXT)}\n\n[… page text truncated …]`
        : pageText;
    parts.push("## Accessibility / page text snapshot", "", "```", snippet, "```", "");
  }

  if (diagnosticsBlock.trim().length > 0) {
    parts.push(diagnosticsBlock, "");
  }

  parts.push(
    "Your task: decide whether the QA instructions pass for the **PR change region** (not for the entire app), then emit ONLY the JSON verdict described below (inside a single ```json fenced block, with no other text).",
    "",
    "## Structured verdict (required)",
    "",
    "- **All strings must be English** (the PR comment is English-only).",
    "- **qaPassed**: boolean.",
    "- **whatYouChecked**: one short sentence — **what behavior or visual aspect** you verified in the scope of the PR (do **not** list visited pages, routes, or navigation items).",
    "- If **qaPassed is false**, you MUST fill **bugs** with one entry per blocking issue:",
    "  - Each bug is a separate object with **title**, **stepsToReproduce** (1–5 imperative steps), **expectedResult**, **actualResult**, and optional **notes**.",
    "  - **Every** blocking finding (visual and functional) must be its own object in `bugs[]`. Do **not** merge two bugs into one. Do **not** leave a second bug only as a plain bullet or as free text inside `notes`.",
    "  - Titles must be short and concrete (one line each).",
    "- If **qaPassed is true**, leave `bugs` empty or omit it.",
    "- **notes**: optional, English, non-blocking context that does not belong to any specific bug.",
    "- Do not use the legacy top-level fields (`headline`, `stepsToReproduce`, `expectedResult`, `actualResult`, `blockingFindings`) — they exist only for backwards compatibility and will be dropped."
  );

  return parts.join("\n");
}

const VERDICT_SYSTEM_PROMPT = [
  "You are a senior QA engineer reviewing a pull request preview build.",
  "You judge only the PR change region using the PR context, attached screenshots (if any), the **DOM text contrast (machine check)** table when present, and the accessibility/page text snapshot.",
  "Visual regressions (invisible or illegible text, same-as-background copy, `aria-hidden` text that the a11y tree omits, hidden/obscured controls, clearly broken layout) are blocking when they fall inside the PR change region — including rows from the **DOM text contrast** section with a near-1.0 ratio, even if the pixels look like empty space.",
  "For normal UI issues, ground every visual claim in the attached screenshots. **Exception:** a row in the **DOM text contrast (machine check)** section (computed in-browser) is sufficient evidence of illegible or invisible *text* when the table gives a very low ratio for that string — the screenshot can show a featureless field; do not require visible letter-shapes. Pure CSS *hypotheses* from the diff without screenshots *or* contrast table support still use 'diff hypothesis, not visually confirmed' — do not use hedged wording like 'may cause' / 'might' / 'could' for that case.",
  "",
  "### Response format (STRICT)",
  "Your entire response must be ONE fenced JSON code block and nothing else:",
  "```json",
  "{ …the verdict object… }",
  "```",
  "- No prose, headers, or commentary before or after the fenced block.",
  "- Think silently. Do not narrate steps. Only output the final JSON inside the fence.",
  "- Emit exactly one ```json fenced block.",
  "",
  "The JSON must exactly match this TypeScript-style shape:",
  "{",
  '  "qaPassed": boolean,',
  '  "whatYouChecked": string,                 // one short English sentence',
  '  "bugs"?: Array<{                          // required and non-empty if qaPassed=false',
  '    "title": string,                         //   one-line English title of THIS bug',
  '    "stepsToReproduce": string[],            //   1-5 imperative steps',
  '    "expectedResult": string,',
  '    "actualResult": string,',
  '    "notes"?: string,                        //   optional, scoped to this bug only',
  '    "kind"?: "visual" | "functional",        //   category — see rules below',
  '    "anchorText"?: string,                   //   REQUIRED when kind="visual" — see rules below',
  '    "anchorHint"?: string                    //   optional disambiguator when anchorText is ambiguous',
  "  }>,",
  '  "notes"?: string                          // optional non-blocking context (not per bug)',
  "}",
  "",
  "Rules for bugs[]:",
  "- Report EVERY blocking issue (functional AND visual) as its own object.",
  "- Do NOT combine two different bugs into a single object.",
  "- Do NOT use the legacy top-level `headline` / `stepsToReproduce` / `expectedResult` / `actualResult` / `blockingFindings` fields.",
  "",
  "Rules for `kind` / `anchorText` / `anchorHint`:",
  "- `kind` classifies the bug: use `'visual'` for regressions that are only visible on screenshots (invisible / illegible text, same-as-background color, hidden or obscured controls, broken layout, low contrast). Use `'functional'` for anything else (broken handler, wrong state, failed fetch, wrong content). If unsure, omit `kind` — it is treated as `'functional'`.",
  "- When `kind === 'visual'`, you MUST also provide `anchorText`: a short, DISTINCTIVE fragment; prefer visible text on the **screenshot**; if the defect is the **DOM text contrast** row, use a **visible** nearby label in the same region, or a fragment of the `textSnippet` (Playwright may still locate the node) — never fabricate new strings that do not exist on the page or in the contrast table.",
  "- If the same anchorText could match several elements on the page, add `anchorHint` with a brief English disambiguator (e.g. 'card in the bottom-right', 'third button in the header row', 'second list item'). Keep it short — it is a hint for a human / script, not a sentence.",
  "- For `kind === 'functional'`, `anchorText` is optional and usually not needed.",
].join("\n");

type VerdictEvidence = {
  userText: string;
  imageParts: Array<{ type: "image"; image: Uint8Array; mediaType: string }>;
};

type ModelLike = Parameters<typeof generateText>[0]["model"];

/**
 * Dispatch ONE verdict LLM call against the shared evidence (screenshots +
 * a11y text + diagnostics). Separated from `computeVerdict` so we can repeat it
 * N times (PR_AGENT_RUNS) without redoing any of the page prep work.
 */
async function callVerdictOnce(
  model: ModelLike,
  evidence: VerdictEvidence,
  runIndex: number,
  runsTotal: number
): Promise<{ verdict: Verdict; raw: string }> {
  console.log(
    `Vision verdict run ${runIndex + 1}/${runsTotal}: calling ${modelName} ` +
      `with ${evidence.imageParts.length} screenshot(s), prompt ${evidence.userText.length} chars.`
  );

  const result = await generateText({
    model,
    system: VERDICT_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: evidence.userText }, ...evidence.imageParts],
      },
    ],
    temperature: 0,
    maxOutputTokens: 2048,
    maxRetries: 1,
  });

  console.log(
    `Verdict run ${runIndex + 1}/${runsTotal} response: finishReason=${result.finishReason}, ` +
      `length=${(result.text ?? "").length}, usage=${JSON.stringify(result.usage)}`
  );

  const raw = (result.text ?? "").trim();
  const parsed = parseVerdictJson(raw);
  const validated = verdictSchema.safeParse(parsed);
  if (!validated.success) {
    console.error(`Raw model output (run ${runIndex + 1}):\n`, raw);
    throw new Error(
      `Model verdict did not match schema (run ${runIndex + 1}/${runsTotal}): ${validated.error.message}`
    );
  }
  return { verdict: validated.data, raw };
}

/**
 * Normalize a bug identity so duplicates across runs collapse to one entry.
 * For visual bugs we prefer anchorText (most specific), otherwise the title.
 */
function bugIdentityKey(bug: Bug): string {
  const kind = bug.kind ?? "functional";
  const anchor = bug.anchorText?.trim().toLowerCase();
  if (kind === "visual" && anchor) {
    return `visual::${anchor}`;
  }
  const title = (bug.title ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return `${kind}::${title}`;
}

/**
 * Aggregate N per-run verdicts with a conservative policy:
 *  - If ANY run has qaPassed=false, the gate fails.
 *  - When it fails, bugs from all failing runs are merged and deduped
 *    (by title / anchorText — see bugIdentityKey).
 *  - whatYouChecked falls back to the longest non-empty string across runs so
 *    the PR comment shows the most informative summary.
 *  - Top-level notes are concatenated from failing runs (deduped verbatim).
 */
function aggregateVerdicts(runs: Verdict[]): Verdict {
  if (runs.length === 0) {
    throw new Error("aggregateVerdicts: received zero runs.");
  }
  if (runs.length === 1) {
    return runs[0]!;
  }

  const failingRuns = runs.filter((r) => !r.qaPassed);
  const aggregatedPassed = failingRuns.length === 0;

  const whatYouCheckedPool = runs
    .map((r) => r.whatYouChecked?.trim() ?? "")
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length);
  const whatYouChecked = whatYouCheckedPool[0] ?? "";

  if (aggregatedPassed) {
    const notesPool = runs
      .map((r) => r.notes?.trim())
      .filter((s): s is string => !!s && s.length > 0);
    return {
      qaPassed: true,
      whatYouChecked,
      bugs: [],
      notes: notesPool[0] ?? null,
    };
  }

  const dedupedBugs = new Map<string, Bug>();
  for (const run of failingRuns) {
    for (const bug of run.bugs ?? []) {
      const key = bugIdentityKey(bug);
      if (!dedupedBugs.has(key)) {
        dedupedBugs.set(key, bug);
      }
    }
  }

  const notesSeen = new Set<string>();
  const mergedNotes: string[] = [];
  for (const run of failingRuns) {
    const n = run.notes?.trim();
    if (!n) continue;
    if (notesSeen.has(n)) continue;
    notesSeen.add(n);
    mergedNotes.push(n);
  }

  return {
    qaPassed: false,
    whatYouChecked,
    bugs: Array.from(dedupedBugs.values()),
    notes: mergedNotes.length > 0 ? mergedNotes.join("\n\n") : null,
  };
}

async function computeVerdict({
  page,
  prCtx,
  qaPrompt,
}: {
  page: { screenshot(options?: { fullPage?: boolean; type?: "png" | "jpeg" }): Promise<Buffer> };
  prCtx: PrContextMaterial | null;
  qaPrompt: string;
}): Promise<VerdictBundle> {
  const prCtxBlock = formatPrContextForPrompt(prCtx);

  const diagnosticsBlock = formatDiagnosticsBlock();
  try {
    writeFileSync(diagnosticsLogPath, diagnosticsBlock, "utf8");
  } catch (e) {
    console.warn(`Could not write diagnostics log to ${diagnosticsLogPath}:`, e);
  }
  console.log(
    `Diagnostics captured: ${consoleEntries.length} console entry(ies).`
  );

  let viewportPng: Buffer | null = null;
  let fullPagePng: Buffer | null = null;
  try {
    viewportPng = await page.screenshot({ type: "png" });
    writeFileSync(viewportScreenshotPath, viewportPng);
    console.log(
      `Saved viewport screenshot to ${viewportScreenshotPath} (${viewportPng.byteLength} bytes).`
    );
  } catch (e) {
    console.warn("Viewport screenshot failed:", e);
  }
  try {
    fullPagePng = await page.screenshot({ fullPage: true, type: "png" });
    writeFileSync(fullPageScreenshotPath, fullPagePng);
    console.log(
      `Saved full-page screenshot to ${fullPageScreenshotPath} (${fullPagePng.byteLength} bytes).`
    );
  } catch (e) {
    console.warn("Full-page screenshot failed:", e);
  }

  const contrastScan = await runDomTextContrastScan(page);
  try {
    if (contrastScan) {
      writeFileSync(
        contrastLogPath,
        JSON.stringify(contrastScan, null, 2) + "\n",
        "utf8"
      );
      console.log(
        `DOM text contrast: ${contrastScan.findings.length} table row(s), ` +
          `${contrastScan.strictHits.length} strict (ratio < ${contrastStrictMaxRatio}). → ${contrastLogPath}`
      );
    }
  } catch (e) {
    console.warn(`Could not write ${contrastLogPath}:`, e);
  }
  const contrastBlock = formatContrastBlockForPrompt(contrastScan);

  let pageText: string | undefined;
  try {
    const textSnap = await globalStagehand!.extract();
    pageText = typeof textSnap?.pageText === "string" ? textSnap.pageText : undefined;
  } catch (e) {
    console.warn("Extracting a11y pageText failed:", e);
  }

  if (!visionEnabled || (!viewportPng && !fullPagePng)) {
    if (!visionEnabled) {
      console.log("Vision disabled via PR_AGENT_VISION=0 — using Stagehand text extract (runs=1).");
    } else {
      console.warn("No screenshots available — falling back to Stagehand text extract (runs=1).");
    }
    const stagehand = globalStagehand;
    if (!stagehand) {
      throw new Error("Stagehand instance unavailable for text-only fallback.");
    }
    const textVerdictRaw = await stagehand.extract(
      buildVerdictPrompt(
        prCtxBlock,
        qaPrompt,
        pageText,
        false,
        contrastBlock,
        diagnosticsBlock
      ),
      verdictSchema
    );
    const textVerdict = applyContrastStrictGate(textVerdictRaw, contrastScan);
    if (textVerdictRaw.qaPassed !== textVerdict.qaPassed) {
      console.warn(
        "PR_AGENT_CONTRAST_STRICT: gate flipped qaPassed (deterministic same-color text vs model)."
      );
    }
    return {
      verdict: textVerdict,
      runsTotal: 1,
      runsFlagged: textVerdict.qaPassed ? 0 : 1,
    };
  }

  const referer =
    process.env.OPENROUTER_HTTP_REFERER?.trim() ||
    "https://github.com/maciejtrabka/qa-bot";

  const openrouter = createOpenAICompatible({
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: apiKey!,
    headers: {
      "HTTP-Referer": referer,
      "X-Title": "qa-bot-pr-browser-agent",
    },
  });

  const model = openrouter.chatModel(modelName);

  const userText = buildVerdictPrompt(
    prCtxBlock,
    qaPrompt,
    pageText,
    true,
    contrastBlock,
    diagnosticsBlock
  );
  const imageParts: Array<{ type: "image"; image: Uint8Array; mediaType: string }> = [];
  if (viewportPng) {
    imageParts.push({ type: "image", image: viewportPng, mediaType: "image/png" });
  }
  if (fullPagePng) {
    imageParts.push({ type: "image", image: fullPagePng, mediaType: "image/png" });
  }

  const evidence: VerdictEvidence = { userText, imageParts };

  console.log(
    `Vision verdict: running ${verdictRuns} pass(es) against the same evidence.`
  );

  const runs: Verdict[] = [];
  const rawDumps: string[] = [];
  for (let i = 0; i < verdictRuns; i++) {
    const { verdict, raw } = await callVerdictOnce(model, evidence, i, verdictRuns);
    runs.push(verdict);
    rawDumps.push(
      `=== Run ${i + 1}/${verdictRuns} (qaPassed=${verdict.qaPassed}) ===\n${raw}`
    );
  }

  try {
    writeFileSync("pr-agent-verdict-raw.txt", rawDumps.join("\n\n"), "utf8");
  } catch {
    /* best-effort */
  }

  const aggregated = aggregateVerdicts(runs);
  const finalVerdict = applyContrastStrictGate(aggregated, contrastScan);
  if (aggregated.qaPassed && !finalVerdict.qaPassed) {
    console.warn(
      "PR_AGENT_CONTRAST_STRICT: gate failed the build (near-1.0 text/background ratio; LLM had qaPassed=true)."
    );
  }
  const llmRunsFlagged = runs.filter((r) => !r.qaPassed).length;
  const runsFlagged = !finalVerdict.qaPassed
    ? Math.max(llmRunsFlagged, 1)
    : llmRunsFlagged;

  console.log(
    `Aggregated verdict: qaPassed=${finalVerdict.qaPassed}, ` +
      `runsFlagged=${runsFlagged}/${runs.length} (conservative: any fail blocks; strict contrast may add a fail).`
  );

  return {
    verdict: finalVerdict,
    runsTotal: runs.length,
    runsFlagged,
  };
}

function parseVerdictJson(raw: string): unknown {
  if (!raw) {
    throw new Error("Model returned empty text for verdict.");
  }

  const direct = tryParseJson(raw);
  if (direct !== undefined) return direct;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const fencedParsed = tryParseJson(fenced[1].trim());
    if (fencedParsed !== undefined) return fencedParsed;
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const slice = raw.slice(firstBrace, lastBrace + 1);
    const sliceParsed = tryParseJson(slice);
    if (sliceParsed !== undefined) return sliceParsed;
  }

  throw new Error(
    `Could not parse JSON from model output. First 500 chars:\n${raw.slice(0, 500)}`
  );
}

function tryParseJson(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Per-bug evidence (when anchorText is set): resolve anchorText to a locator
// and save a padded viewport clip around that element as `pr-agent-bug-<n>.png`.
// Runs for both visual and functional bugs if `anchorText` is present (kind alone
// does not gate this). Only triggered when qaPassed === false. Failures are non-fatal.
// ---------------------------------------------------------------------------

type BBox = { x: number; y: number; width: number; height: number };

type LocatorLike = {
  count(): Promise<number>;
  nth(index: number): LocatorLike;
  first(): LocatorLike;
  isVisible(): Promise<boolean>;
  boundingBox(): Promise<BBox | null>;
  evaluate<R = void>(fn: (el: Element) => R): Promise<R>;
};

type PageLike = {
  getByText(text: string, options?: { exact?: boolean }): LocatorLike;
  viewportSize(): { width: number; height: number } | null;
  screenshot(options?: {
    clip?: BBox;
    fullPage?: boolean;
    type?: "png" | "jpeg";
  }): Promise<Buffer>;
};

/** Padding around getBoundingClientRect() for the cropped bug screenshot. */
const BUG_CLIP_PADDING_PX = 40;
const BUG_ANCHOR_MAX_CANDIDATES = 10;

function padClip(
  box: BBox,
  pad: number,
  viewport: { width: number; height: number } | null
): BBox {
  const vw = viewport?.width ?? Number.POSITIVE_INFINITY;
  const vh = viewport?.height ?? Number.POSITIVE_INFINITY;
  const x = Math.max(0, Math.floor(box.x - pad));
  const y = Math.max(0, Math.floor(box.y - pad));
  const rightBound = Math.min(vw, Math.ceil(box.x + box.width + pad));
  const bottomBound = Math.min(vh, Math.ceil(box.y + box.height + pad));
  const width = Math.max(1, rightBound - x);
  const height = Math.max(1, bottomBound - y);
  return { x, y, width, height };
}

/**
 * Scroll likely matches into view, then pick the first candidate that has a
 * non-empty bounding box overlapping the viewport.
 */
async function resolveBugAnchor(
  locator: LocatorLike,
  viewport: { width: number; height: number } | null
): Promise<{ locator: LocatorLike; box: BBox } | null> {
  const count = await locator.count().catch(() => 0);
  if (count === 0) return null;
  const vw = viewport?.width ?? Number.POSITIVE_INFINITY;
  const vh = viewport?.height ?? Number.POSITIVE_INFINITY;
  const cap = Math.min(count, BUG_ANCHOR_MAX_CANDIDATES);
  for (let i = 0; i < cap; i++) {
    const candidate = locator.nth(i);
    try {
      await candidate.evaluate((el: Element) => {
        el.scrollIntoView({ block: "center", inline: "nearest" });
      });
    } catch {
      /* try next */
    }
    await new Promise<void>((r) => setTimeout(r, 120));
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;
    const box = await candidate.boundingBox().catch(() => null);
    if (!box || box.width <= 0 || box.height <= 0) continue;
    if (box.x + box.width <= 0 || box.y + box.height <= 0) continue;
    if (box.x >= vw || box.y >= vh) continue;
    return { locator: candidate, box };
  }
  return null;
}

async function captureBugEvidence(
  page: PageLike,
  bugs: Bug[]
): Promise<Array<{ index: number; file: string }>> {
  const anchored = bugs
    .map((bug, index) => ({ bug, index }))
    .filter(({ bug }) => !!bug.anchorText?.trim());
  if (anchored.length === 0) return [];

  const viewport = page.viewportSize();
  const out: Array<{ index: number; file: string }> = [];

  for (const { bug, index } of anchored) {
    const text = (bug.anchorText ?? "").trim();
    const hint = bug.anchorHint?.trim();
    const hintSuffix = hint ? ` (hint: ${hint})` : "";
    const locator = page.getByText(text, { exact: false });
    const count = await locator.count().catch(() => 0);
    if (count === 0) {
      console.warn(
        `captureBugEvidence: bug #${index + 1} anchor not found — anchorText="${text}"${hintSuffix}`
      );
      continue;
    }

    const resolved = await resolveBugAnchor(locator, viewport);
    if (!resolved) {
      console.warn(
        `captureBugEvidence: bug #${index + 1} anchor matched ${count} element(s) but none is visible in viewport — anchorText="${text}"${hintSuffix}`
      );
      continue;
    }
    if (count > 1) {
      console.warn(
        `captureBugEvidence: bug #${index + 1} anchor matched ${count} element(s); using the first visible one — anchorText="${text}"${hintSuffix}`
      );
    }

    try {
      const padded = padClip(resolved.box, BUG_CLIP_PADDING_PX, viewport);
      const file = `pr-agent-bug-${index + 1}.png`;
      const png = await page.screenshot({ clip: padded, type: "png" });
      writeFileSync(file, png);
      console.log(
        `captureBugEvidence: saved ${file} (${png.byteLength} bytes) for bug #${index + 1}`
      );
      out.push({ index: index + 1, file });
    } catch (e) {
      console.warn(
        `captureBugEvidence: bug #${index + 1} screenshot failed:`,
        e
      );
    }
  }

  return out;
}

let globalStagehand: Stagehand | null = null;

async function main() {
  if (!apiKey) {
    const m = "Missing OPENROUTER_API_KEY (required for Stagehand LLM steps in CI).";
    console.error(m);
    writeFileSync(failureLogPath, m, "utf8");
    writePrFailureComment(
      formatGenericFailureComment(
        "Missing OPENROUTER_API_KEY in GitHub Actions (Settings → Secrets and variables → Actions)."
      )
    );
    process.exit(1);
  }

  const referer =
    process.env.OPENROUTER_HTTP_REFERER?.trim() ||
    "https://github.com/maciejtrabka/qa-bot";

  const stagehand = new Stagehand({
    env: "LOCAL",
    verbose: 1,
    model: {
      modelName,
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      headers: {
        "HTTP-Referer": referer,
        "X-Title": "qa-bot-pr-browser-agent",
      },
    },
    localBrowserLaunchOptions: {
      headless: true,
      chromiumSandbox: false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    },
  });
  globalStagehand = stagehand;

  try {
    const qaPrompt = loadQaPrompt();
    await stagehand.init();
    const page = stagehand.context.pages()[0];
    if (!page) {
      throw new Error("Stagehand did not provide an initial page.");
    }

    attachDiagnosticsListeners(page);

    console.log(`Navigating to BASE_URL: ${BASE_URL}`);
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeoutMs: 30_000 });
    try {
      await page.waitForLoadState("networkidle", 5_000);
    } catch {
      /* non-fatal — SPA often stays busy briefly */
    }
    console.log(`Loaded page: ${page.url()}`);

    const prCtx = loadPrContext();
    const prCtxBlock = formatPrContextForPrompt(prCtx);
    if (prCtx) {
      console.log("PR context loaded:", {
        title: prCtx.title,
        filesChars: prCtx.changedFiles.length,
        diffChars: prCtx.diffPatch.length,
      });
    } else {
      console.log("PR context not found; running without PR metadata.");
    }

    const origin = new URL(`${BASE_URL}/`).origin;

    const actText = buildActInstruction(prCtxBlock, qaPrompt, origin);
    await stagehand.act(actText);

    const verdictBundle = await computeVerdict({
      page,
      prCtx,
      qaPrompt,
    });
    const { verdict, runsTotal, runsFlagged } = verdictBundle;

    console.log(
      `LLM verdict (aggregated from ${runsTotal} pass(es), ${runsFlagged} flagged):`,
      JSON.stringify(verdict, null, 2)
    );

    if (!verdict.qaPassed) {
      const env: QaEnvironment = {
        previewUrl: BASE_URL,
        userAgent: await safeGetUserAgent(page),
        runTimeUtc: new Date().toISOString(),
      };
      const bugs = collectBugs(verdict);
      const evidence = await captureBugEvidence(
        page as unknown as PageLike,
        bugs
      ).catch((e) => {
        console.warn("captureBugEvidence failed:", e);
        return [] as Array<{ index: number; file: string }>;
      });
      const artifactSnapshot: PrArtifactSnapshot = {
        savedViewport: existsSync(viewportScreenshotPath),
        savedFullPage: existsSync(fullPageScreenshotPath),
        bugEvidenceFiles: evidence.length,
      };
      writePrFailureComment(
        formatQaVerdictComment(verdict, env, evidence, { runsTotal, runsFlagged }, artifactSnapshot)
      );
      const firstBugTitle = verdict.bugs?.find((b) => b?.title?.trim())?.title?.trim();
      const hint =
        firstBugTitle ??
        verdict.blockingFindings?.find((s) => s?.trim())?.trim() ??
        verdict.whatYouChecked.slice(0, 160);
      throw new Error(
        `QA gate failed (qaPassed=false, ${runsFlagged}/${runsTotal} runs flagged): ${hint}`
      );
    }

    console.log("PR browser agent: QA gate passed (model verdict).");
  } catch (e) {
    const detail =
      e instanceof Error ? `${e.message}\n\n${e.stack ?? ""}` : String(e);
    const detailWithHints = appendFailureDiagnostics(detail);
    console.error(detailWithHints);
    try {
      writeFileSync(failureLogPath, detailWithHints, "utf8");
    } catch {
      /* ignore */
    }
    if (!existsSync(prAgentPrCommentPath)) {
      writePrFailureComment(
        formatGenericFailureComment(firstMeaningfulFailureLine(detail))
      );
    }
    process.exitCode = 1;
  } finally {
    await stagehand.close().catch(() => undefined);
  }

  if (process.exitCode === 1) {
    process.exit(1);
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
