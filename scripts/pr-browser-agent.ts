/**
 * PR browser agent: Stagehand (LOCAL) + OpenRouter. Optional PR context (pr-context/).
 * QA steps and pass/fail criteria come from a prompt file or PR_AGENT_PROMPT env.
 * Merge gate: structured verdict — qaPassed must be true.
 *
 * Verdict step uses a vision-capable LLM call by default (screenshots + a11y tree +
 * PR context), so the agent also catches visual-only regressions that the DOM tree
 * alone would miss. Disable with PR_AGENT_VISION=0 to fall back to Stagehand's
 * text-only `extract()`.
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

const viewportScreenshotPath =
  process.env.PR_AGENT_SCREENSHOT_VIEWPORT?.trim() ||
  "pr-agent-screenshot-viewport.png";
const fullPageScreenshotPath =
  process.env.PR_AGENT_SCREENSHOT_FULLPAGE?.trim() ||
  "pr-agent-screenshot-fullpage.png";

const failureLogPath = process.env.PR_AGENT_FAILURE_LOG ?? "pr-agent-failure.txt";

/** Short markdown for `gh pr comment` (written on failure; workflow reads this file). */
const prAgentPrCommentPath =
  process.env.PR_AGENT_PR_COMMENT_FILE?.trim() || "pr-agent-pr-comment.md";

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

function renderEnvironmentSection(env: QaEnvironment): string[] {
  return [
    "### Environment",
    "",
    `- **Browser:** ${trimForPrComment(env.userAgent || "(unknown)", 240)}`,
    `- **Run time (UTC):** ${env.runTimeUtc}`,
    "",
  ];
}

function formatQaVerdictComment(verdict: Verdict, env: QaEnvironment): string {
  const bugs = collectBugs(verdict);
  const notes = verdict.notes?.trim()
    ? trimForPrComment(verdict.notes.trim(), 280)
    : "";

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
  });

  parts.push(...DOUBLE_HR, ...renderEnvironmentSection(env));

  if (notes) {
    parts.push(...DOUBLE_HR, "### Notes", "", notes, "");
  }

  parts.push("---", "", "<sub>Full logs: workflow artifact **pr-agent-logs**.</sub>");

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
    "<sub>Full logs: workflow artifact **pr-agent-logs**.</sub>",
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
  hasScreenshots: boolean
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
      "- Any visual issue you report — in `bugs[]`, in a bug's `notes`, or in the top-level `notes` — MUST be anchored to a concrete observation on the attached screenshots: say what you actually see (or what is missing) in a specific region (e.g. 'the strip under the counter shows no hint text', 'the label blends into the card background and is unreadable', 'the button overlaps the badge').",
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
      "No screenshots are attached for this run — judge from the PR context and the accessibility/page text snapshot only.",
      ""
    );
  }

  if (pageText && pageText.trim().length > 0) {
    const MAX_PAGE_TEXT = 20_000;
    const snippet =
      pageText.length > MAX_PAGE_TEXT
        ? `${pageText.slice(0, MAX_PAGE_TEXT)}\n\n[… page text truncated …]`
        : pageText;
    parts.push("## Accessibility / page text snapshot", "", "```", snippet, "```", "");
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

async function computeVerdict({
  page,
  prCtx,
  qaPrompt,
}: {
  page: { screenshot(options?: { fullPage?: boolean; type?: "png" | "jpeg" }): Promise<Buffer> };
  prCtx: PrContextMaterial | null;
  qaPrompt: string;
}): Promise<z.infer<typeof verdictSchema>> {
  const prCtxBlock = formatPrContextForPrompt(prCtx);

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

  if (!visionEnabled || (!viewportPng && !fullPagePng)) {
    if (!visionEnabled) {
      console.log("Vision disabled via PR_AGENT_VISION=0 — using Stagehand text extract.");
    } else {
      console.warn("No screenshots available — falling back to Stagehand text extract.");
    }
    const stagehand = globalStagehand;
    if (!stagehand) {
      throw new Error("Stagehand instance unavailable for text-only fallback.");
    }
    return stagehand.extract(
      buildVerdictPrompt(prCtxBlock, qaPrompt, undefined, false),
      verdictSchema
    );
  }

  let pageText: string | undefined;
  try {
    const textSnap = await globalStagehand!.extract();
    pageText = typeof textSnap?.pageText === "string" ? textSnap.pageText : undefined;
  } catch (e) {
    console.warn("Extracting a11y pageText failed:", e);
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

  const userText = buildVerdictPrompt(prCtxBlock, qaPrompt, pageText, true);
  const imageParts: Array<{ type: "image"; image: Uint8Array; mediaType: string }> = [];
  if (viewportPng) {
    imageParts.push({ type: "image", image: viewportPng, mediaType: "image/png" });
  }
  if (fullPagePng) {
    imageParts.push({ type: "image", image: fullPagePng, mediaType: "image/png" });
  }

  console.log(
    `Vision verdict: calling ${modelName} with ${imageParts.length} screenshot(s), prompt ${userText.length} chars.`
  );

  const systemPrompt = [
    "You are a senior QA engineer reviewing a pull request preview build.",
    "You judge only the PR change region based on the PR context, attached screenshots, and the accessibility/page text snapshot.",
    "Visual regressions that only show up in screenshots (invisible or illegible text, hidden/obscured controls, clearly broken layout) are blocking when they fall inside the PR change region.",
    "Every visual claim in your verdict must be grounded in the attached screenshots, not in CSS rules from the diff. If the diff hints at a visual problem that the screenshots do not confirm, either omit it or state 'diff hypothesis, not visually confirmed' — do not use hedged wording like 'may cause' / 'might' / 'could'.",
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
    '    "notes"?: string                         //   optional, scoped to this bug only',
    "  }>,",
    '  "notes"?: string                          // optional non-blocking context (not per bug)',
    "}",
    "",
    "Rules for bugs[]:",
    "- Report EVERY blocking issue (functional AND visual) as its own object.",
    "- Do NOT combine two different bugs into a single object.",
    "- Do NOT use the legacy top-level `headline` / `stepsToReproduce` / `expectedResult` / `actualResult` / `blockingFindings` fields.",
  ].join("\n");

  const result = await generateText({
    model,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: userText }, ...imageParts],
      },
    ],
    temperature: 0,
    maxOutputTokens: 2048,
    maxRetries: 1,
  });

  console.log(
    `Verdict response: finishReason=${result.finishReason}, length=${(result.text ?? "").length}, usage=${JSON.stringify(result.usage)}`
  );

  const raw = (result.text ?? "").trim();
  try {
    writeFileSync("pr-agent-verdict-raw.txt", raw, "utf8");
  } catch {
    /* best-effort */
  }
  const parsed = parseVerdictJson(raw);
  const validated = verdictSchema.safeParse(parsed);
  if (!validated.success) {
    console.error("Raw model output:\n", raw);
    throw new Error(
      `Model verdict did not match schema: ${validated.error.message}`
    );
  }
  return validated.data;
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

    const verdict = await computeVerdict({
      page,
      prCtx,
      qaPrompt,
    });

    console.log("LLM verdict:", JSON.stringify(verdict, null, 2));

    if (!verdict.qaPassed) {
      const env: QaEnvironment = {
        previewUrl: BASE_URL,
        userAgent: await safeGetUserAgent(page),
        runTimeUtc: new Date().toISOString(),
      };
      writePrFailureComment(formatQaVerdictComment(verdict, env));
      const firstBugTitle = verdict.bugs?.find((b) => b?.title?.trim())?.title?.trim();
      const hint =
        firstBugTitle ??
        verdict.blockingFindings?.find((s) => s?.trim())?.trim() ??
        verdict.whatYouChecked.slice(0, 160);
      throw new Error(`QA gate failed (qaPassed=false): ${hint}`);
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
