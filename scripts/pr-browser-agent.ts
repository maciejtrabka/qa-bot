/**
 * PR browser agent: Stagehand (LOCAL) + OpenRouter. Optional PR context (pr-context/).
 * QA steps and pass/fail criteria come from a prompt file or PR_AGENT_PROMPT env.
 * Merge gate: structured extract — qaPassed must be true.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Stagehand } from "@browserbasehq/stagehand";
import type { Page as StagehandPage } from "@browserbasehq/stagehand/lib/v3/understudy/page.js";
import { z } from "zod";

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:9333").replace(
  /\/$/,
  ""
);
const apiKey = process.env.OPENROUTER_API_KEY?.trim();
const modelName =
  process.env.STAGEHAND_MODEL?.trim() ||
  "meta-llama/llama-3.3-70b-instruct:free";

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

const verdictSchema = z.object({
  qaPassed: z
    .boolean()
    .describe(
      "true only if every blocking criterion from the QA instructions is satisfied"
    ),
  whatYouChecked: z.string(),
  blockingFindings: z.array(z.string()).nullish(),
  notes: z.string().nullish(),
});

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
      "Do general exploratory QA on this page only.",
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
  const max = 8000;
  const out =
    markdown.length > max ? `${markdown.slice(0, max)}\n\n[obcięto]` : markdown;
  writeFileSync(prAgentPrCommentPath, out, "utf8");
}

function formatQaVerdictComment(
  verdict: z.infer<typeof verdictSchema>
): string {
  const checked = trimForPrComment(verdict.whatYouChecked, 320);
  const findings = (verdict.blockingFindings?.filter((s) => s?.trim()) ?? []).slice(
    0,
    6
  );
  const notes = verdict.notes?.trim()
    ? trimForPrComment(verdict.notes.trim(), 400)
    : "";

  const parts = [
    "### Agent PR gate — niepowodzenie",
    "",
    "Check **`pr_browser_agent`** nie przeszedł — model zwrócił **`qaPassed: false`**.",
    "",
    "**Co sprawdzono:**",
    checked,
    "",
  ];

  if (findings.length) {
    parts.push(
      "**Blokuje merge:**",
      ...findings.map((f) => `- ${trimForPrComment(f, 420)}`),
      ""
    );
  } else {
    parts.push(
      "**Blokuje merge:** brak listy `blockingFindings` z modelu — zajrzyj do logów w Actions.",
      ""
    );
  }

  if (notes) {
    parts.push("**Notatka:**", notes, "");
  }

  parts.push(
    "<sub>Pełne logi: artefakt **pr-agent-logs** (workflow *PR browser agent*).</sub>"
  );

  return parts.join("\n");
}

function firstMeaningfulFailureLine(detail: string): string {
  const head = detail.split(/\n\s*at\s+/m)[0] ?? detail;
  const line = head.split("\n").find((l) => l.trim())?.trim() ?? "Unknown error";
  return trimForPrComment(line, 500);
}

function formatGenericFailureComment(summary: string): string {
  return [
    "### Agent PR gate — niepowodzenie",
    "",
    "Agent nie ukończył kroku QA (błąd narzędzia, API lub nieprzewidywana odpowiedź).",
    "",
    "**Skrót:**",
    summary,
    "",
    "<sub>Pełne logi: artefakt **pr-agent-logs**.</sub>",
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
      "## Podpowiedź (wykryto limit API)",
      "",
      "W logu widać sygnały **HTTP 429 / rate limit** albo równoważny komunikat o **limicie zapytań**.",
      "To zwykle **przepustowość lub quota u dostawcy** (np. OpenRouter), często przy **darmowym lub tanim modelu** — **nie** oznacza samo w sobie, że zmiana w PR jest zła.",
      "Co dalej: odczekaj i **uruchom workflow ponownie**, rozważ **płatny plan / inny model** (`STAGEHAND_MODEL`), ewentualnie **retry z backoff** w pipeline."
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
      "## Podpowiedź (błąd infrastruktury LLM)",
      "",
      "Błąd wygląda na **odmowę lub niepoprawną odpowiedź API** (nie na werdykt QA z prompta).",
      "Sprawdź status OpenRouter, limity konta i ustawienia modelu; ponów run — to **nie** jest twardy dowód regresji w UI."
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

/**
 * Hard gate: primary CTA must append a visible line under hello-output.
 * Catches wiring/selector bugs that an LLM may excuse when the PR title says "style only".
 * Skip locally with PR_AGENT_SKIP_SMOKE=1.
 */
async function runDeterministicLandingSmoke(page: StagehandPage): Promise<void> {
  if (process.env.PR_AGENT_SKIP_SMOKE?.trim() === "1") {
    console.log("Deterministic smoke: skipped (PR_AGENT_SKIP_SMOKE=1)");
    return;
  }

  await page.goto(`${BASE_URL}/`, {
    waitUntil: "domcontentloaded",
    timeoutMs: 30_000,
  });

  const cta = page.locator('[data-testid="cta-primary"]');
  const lineLocator = page.locator('[data-testid="hello-output"] .hello-line');

  const visible = await cta.isVisible().catch(() => false);
  if (!visible) {
    const msg =
      "Deterministic QA failed: [data-testid=cta-primary] not visible — page may be broken or wrong route.";
    writePrFailureComment(formatGenericFailureComment(msg));
    throw new Error(msg);
  }

  const linesBefore = await lineLocator.count();
  await cta.click();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const n = await lineLocator.count();
    if (n > linesBefore) {
      console.log("Deterministic smoke: OK (hello lines:", n, ")");
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  const msg =
    "Deterministic QA failed: after clicking [data-testid=cta-primary], expected a new .hello-line under [data-testid=hello-output] (e.g. broken querySelector, dead handler, or wrong container).";
  writePrFailureComment(
    formatGenericFailureComment(
      "Twardy test (CDP): przycisk CTA nie dodał oczekiwanego wiersza — patrz log."
    )
  );
  throw new Error(msg);
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
    `**Scope:** only the app under **${origin}**. Do not navigate away from this origin. Use a single tab.`,
  ].join("\n");

  if (core.length > MAX_ACT_PROMPT) {
    return `${core.slice(0, MAX_ACT_PROMPT)}\n\n[… act instruction truncated …]`;
  }
  return core;
}

async function main() {
  if (!apiKey) {
    const m = "Missing OPENROUTER_API_KEY (required for Stagehand LLM steps in CI).";
    console.error(m);
    writeFileSync(failureLogPath, m, "utf8");
    writePrFailureComment(
      formatGenericFailureComment(
        "Brak sekretu OPENROUTER_API_KEY w GitHub Actions (Settings → Secrets and variables → Actions)."
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

  try {
    const qaPrompt = loadQaPrompt();
    await stagehand.init();
    const page = stagehand.context.pages()[0];
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

    await runDeterministicLandingSmoke(page);

    const actText = buildActInstruction(prCtxBlock, qaPrompt, origin);
    await stagehand.act(actText);

    const verdict = await stagehand.extract(
      [
        formatPrContextForPrompt(prCtx),
        "",
        "## QA instructions (same as for actions)",
        qaPrompt,
        "",
        "Based only on the current page state after your exploration: did the QA instructions pass?",
        'Respond with qaPassed (boolean), whatYouChecked (short), optional blockingFindings (strings), optional notes.',
      ].join("\n"),
      verdictSchema
    );

    console.log("LLM verdict:", JSON.stringify(verdict, null, 2));

    if (!verdict.qaPassed) {
      writePrFailureComment(formatQaVerdictComment(verdict));
      const hint =
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
