/**
 * Local eval harness for pr_browser_agent: apply case patches, serve dist,
 * copy pr-context, run scripts/pr-browser-agent.ts, aggregate CSV + summary.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const CASES_DIR = join(ROOT, "evals", "cases");
const RESULTS_CSV = join(ROOT, "evals", "results.csv");
const PR_CONTEXT_DEST = join(ROOT, "pr-context");
const SERVE_HOST = "127.0.0.1";
const SERVE_PORT = Number.parseInt(process.env.EVALS_PORT ?? "9333", 10);
const BASE_URL = process.env.BASE_URL ?? `http://${SERVE_HOST}:${SERVE_PORT}`;
const EVALS_N = Math.min(
  5,
  Math.max(
    1,
    Number.parseInt(process.env.EVALS_N ?? process.env.PR_AGENT_RUNS ?? "2", 10)
  )
);
const CASE_FILTER = (process.env.EVALS_CASES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

type CaseJson = {
  id: string;
  notePl?: string;
  expected: {
    qaPassed: boolean;
    minBugs?: number;
    kindAtLeastOne?: "visual" | "functional" | null;
  };
};

type RunRow = {
  caseId: string;
  runIndex: number;
  runsTotal: number;
  expectedPassed: boolean;
  gotPassed: boolean;
  match: boolean;
  aggregatedPassed: boolean;
  aggregatedMatch: boolean;
  bugsCount: number;
  firstBugTitle: string;
  durationMsCase: number;
  inputTokens: number | "";
  outputTokens: number | "";
};

function runCmd(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? ROOT,
      env: { ...process.env, ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function waitForHttp(url: string, maxMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 404) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timeout waiting for ${url}`);
}

function listCaseDirs(): string[] {
  if (!existsSync(CASES_DIR)) return [];
  return readdirSync(CASES_DIR)
    .filter((name) => statSync(join(CASES_DIR, name)).isDirectory())
    .sort();
}

function loadCaseJson(dir: string): CaseJson {
  const raw = readFileSync(join(dir, "case.json"), "utf8");
  return JSON.parse(raw) as CaseJson;
}

function cleanAgentArtifacts(): void {
  const names = [
    "pr-agent-verdict-raw.txt",
    "pr-agent-diagnostics.txt",
    "pr-agent-failure.txt",
    "pr-agent-screenshot-viewport.png",
    "pr-agent-screenshot-fullpage.png",
  ];
  for (const n of names) {
    const p = join(ROOT, n);
    if (existsSync(p)) rmSync(p);
  }
  for (let i = 1; i <= 8; i++) {
    const p = join(ROOT, `pr-agent-bug-${i}.png`);
    if (existsSync(p)) rmSync(p);
  }
}

function removePrContextDir(): void {
  if (existsSync(PR_CONTEXT_DEST)) {
    rmSync(PR_CONTEXT_DEST, { recursive: true, force: true });
  }
}

function copyCasePrContext(caseDir: string): void {
  const src = join(caseDir, "pr-context");
  if (!existsSync(src)) {
    throw new Error(`Missing ${src}`);
  }
  removePrContextDir();
  cpSync(src, PR_CONTEXT_DEST, { recursive: true });
}

function parseVerdictRuns(
  raw: string
): Array<{ index: number; total: number; qaPassed: boolean; bugsCount: number; firstBugTitle: string }> {
  const runs: Array<{
    index: number;
    total: number;
    qaPassed: boolean;
    bugsCount: number;
    firstBugTitle: string;
  }> = [];
  const headerRe = /^=== Run (\d+)\/(\d+) \(qaPassed=(true|false)\) ===\r?\n/m;
  let pos = 0;
  while (pos < raw.length) {
    const slice = raw.slice(pos);
    const m = slice.match(headerRe);
    if (!m) break;
    const index = Number.parseInt(m[1]!, 10);
    const total = Number.parseInt(m[2]!, 10);
    const qaPassed = m[3] === "true";
    const start = pos + m[0].length;
    const next = raw.slice(start).search(/^=== Run \d+\/\d+ /m);
    const body = next === -1 ? raw.slice(start) : raw.slice(start, start + next);
    const { bugsCount, firstBugTitle } = extractBugsFromBlock(body);
    runs.push({ index, total, qaPassed, bugsCount, firstBugTitle });
    pos = next === -1 ? raw.length : start + next;
  }
  return runs;
}

function extractBugsFromBlock(block: string): {
  bugsCount: number;
  firstBugTitle: string;
} {
  const qaM = block.match(/"qaPassed"\s*:\s*(true|false)/);
  if (!qaM) return { bugsCount: 0, firstBugTitle: "" };
  const jsonFence = block.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = jsonFence ? jsonFence[1]!.trim() : block;
  const tryParse = (): unknown => {
    try {
      const fence = text.indexOf("{");
      if (fence === -1) return null;
      let depth = 0;
      let i = fence;
      for (; i < text.length; i++) {
        const c = text[i];
        if (c === "{") depth++;
        if (c === "}") {
          depth--;
          if (depth === 0) {
            return JSON.parse(text.slice(fence, i + 1));
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  };
  const parsed = tryParse() as { bugs?: unknown[] } | null;
  if (parsed && Array.isArray(parsed.bugs)) {
    const bugs = parsed.bugs;
    const t0 =
      typeof bugs[0] === "object" && bugs[0] && "title" in bugs[0]
        ? String((bugs[0] as { title?: string }).title ?? "")
        : "";
    return { bugsCount: bugs.length, firstBugTitle: t0 };
  }
  const titleM = block.match(/"title"\s*:\s*"([^"]*)"/);
  return {
    bugsCount: qaM[1] === "false" ? 1 : 0,
    firstBugTitle: titleM?.[1] ?? "",
  };
}

function parseUsageFromAgentLog(stdout: string, stderr: string): Array<{
  runIndex: number;
  input: number | "";
  output: number | "";
}> {
  const out: Array<{ runIndex: number; input: number | ""; output: number | "" }> = [];
  // `pr-browser-agent` logs verdict usage with console.log → stdout
  const lines = `${stdout}\n${stderr}`.split("\n");
  for (const line of lines) {
    const m = line.match(/Verdict run (\d+)\/(\d+) response:.*usage=/);
    if (!m) continue;
    const runIndex = Number.parseInt(m[1]!, 10);
    const uStart = line.indexOf("usage=");
    if (uStart === -1) continue;
    let jsonStr = line.slice(uStart + 6).trim();
    const o = jsonStr.indexOf("{");
    if (o !== -1) {
      let depth = 0;
      for (let i = o; i < jsonStr.length; i++) {
        if (jsonStr[i] === "{") depth++;
        if (jsonStr[i] === "}") {
          depth--;
          if (depth === 0) {
            jsonStr = jsonStr.slice(o, i + 1);
            break;
          }
        }
      }
    }
    try {
      const u = JSON.parse(jsonStr) as Record<string, number | undefined>;
      const input =
        u.promptTokens ?? u.inputTokens ?? u.prompt_tokens ?? u.input_tokens;
      const output =
        u.completionTokens ??
        u.outputTokens ??
        u.completion_tokens ??
        u.output_tokens;
      out.push({
        runIndex,
        input: typeof input === "number" ? input : "",
        output: typeof output === "number" ? output : "",
      });
    } catch {
      out.push({ runIndex, input: "", output: "" });
    }
  }
  return out;
}

function escapeCsv(s: string | number | boolean | ""): string {
  const t = String(s);
  if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

async function resetWorkspaceToMain(): Promise<void> {
  await runCmd("git", ["reset", "--hard", "HEAD"], { cwd: ROOT });
  removePrContextDir();
}

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    console.error("Missing OPENROUTER_API_KEY (required to run the browser agent).");
    process.exit(1);
  }

  const stashMode = (process.env.EVALS_GIT_STASH ?? "tracked").trim();
  let didStash = false;
  if (stashMode === "tracked") {
    const r = await runCmd("git", ["stash", "push", "-m", "pr-browser-evals"], {
      cwd: ROOT,
    });
    if (r.code !== 0 && !r.stderr.includes("No local changes to save")) {
      console.warn("git stash:", r.stderr);
    }
    didStash =
      r.stdout.includes("Saved working directory") ||
      r.stderr.includes("Saved working directory");
  } else if (stashMode === "all" || stashMode === "untracked") {
    const r = await runCmd("git", ["stash", "push", "-u", "-m", "pr-browser-evals"], {
      cwd: ROOT,
    });
    didStash =
      r.stdout.includes("Saved working directory") ||
      r.stderr.includes("Saved working directory");
  }

  const caseDirs = listCaseDirs().filter((name) => {
    if (CASE_FILTER.length === 0) return true;
    return CASE_FILTER.some((f) => name === f || name.startsWith(f));
  });

  if (caseDirs.length === 0) {
    console.error("No cases under evals/cases/ (check EVALS_CASES filter).");
    process.exit(1);
  }

  const rows: RunRow[] = [];
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0;
  let flakeCases = 0;

  for (const name of caseDirs) {
    const caseDir = join(CASES_DIR, name);
    const caseJsonPath = join(caseDir, "case.json");
    const patchPath = join(caseDir, "change.patch");
    if (!existsSync(caseJsonPath) || !existsSync(patchPath)) {
      console.warn(`Skip ${name}: missing case.json or change.patch`);
      continue;
    }

    const meta = loadCaseJson(caseDir);
    const expectedPassed = meta.expected.qaPassed;

    console.log(`\n── Case ${meta.id} ──`);

    await resetWorkspaceToMain();
    const apply = await runCmd("git", ["apply", patchPath], { cwd: ROOT });
    if (apply.code !== 0) {
      console.error(`git apply failed for ${name}:\n${apply.stderr}`);
      continue;
    }

    const build = await runCmd("npm", ["run", "build"], { cwd: ROOT });
    if (build.code !== 0) {
      console.error(`npm run build failed:\n${build.stderr}`);
      await resetWorkspaceToMain();
      continue;
    }

    copyCasePrContext(caseDir);

    let serveProc: ReturnType<typeof spawn> | null = null;
    const t0 = Date.now();
    try {
      serveProc = spawn(
        join(ROOT, "node_modules", ".bin", "serve"),
        [join(ROOT, "dist"), "-l", String(SERVE_PORT)],
        {
          cwd: ROOT,
          env: { ...process.env, PATH: process.env.PATH },
          detached: false,
        }
      );
      await waitForHttp(`${BASE_URL}/`);

      cleanAgentArtifacts();

      const agentEnv = {
        ...process.env,
        BASE_URL,
        PR_AGENT_RUNS: String(EVALS_N),
        PR_AGENT_CONTEXT_DIR: PR_CONTEXT_DEST,
      };

      const agent = await runCmd(
        join(ROOT, "node_modules", ".bin", "tsx"),
        [join(ROOT, "scripts", "pr-browser-agent.ts")],
        { cwd: ROOT, env: agentEnv }
      );

      const verdictPath = join(ROOT, "pr-agent-verdict-raw.txt");
      const rawVerdict = existsSync(verdictPath)
        ? readFileSync(verdictPath, "utf8")
        : "";
      const runs = parseVerdictRuns(rawVerdict);
      const usageRows = parseUsageFromAgentLog(agent.stdout, agent.stderr);

      const gotPasses = runs.map((r) => r.qaPassed);
      const aggregatedPassed =
        gotPasses.length > 0 ? gotPasses.every(Boolean) : agent.code === 0;
      const aggregatedMatch = aggregatedPassed === expectedPassed;

      if (expectedPassed) {
        if (aggregatedMatch) tn++;
        else fp++;
      } else {
        if (aggregatedMatch) tp++;
        else fn++;
      }

      const verdictFlake =
        gotPasses.length > 1 &&
        new Set(gotPasses).size > 1;
      if (verdictFlake) flakeCases++;

      const durationMs = Date.now() - t0;

      if (runs.length === 0) {
        rows.push({
          caseId: meta.id,
          runIndex: 1,
          runsTotal: EVALS_N,
          expectedPassed,
          gotPassed: agent.code === 0,
          match: (agent.code === 0) === expectedPassed,
          aggregatedPassed,
          aggregatedMatch,
          bugsCount: 0,
          firstBugTitle: "(no verdict parse)",
          durationMsCase: durationMs,
          inputTokens: "",
          outputTokens: "",
        });
      } else {
        for (const r of runs) {
          const u = usageRows.find((x) => x.runIndex === r.index);
          rows.push({
            caseId: meta.id,
            runIndex: r.index,
            runsTotal: r.total,
            expectedPassed,
            gotPassed: r.qaPassed,
            match: r.qaPassed === expectedPassed,
            aggregatedPassed,
            aggregatedMatch,
            bugsCount: r.bugsCount,
            firstBugTitle: r.firstBugTitle,
            durationMsCase: r.index === 1 ? durationMs : 0,
            inputTokens: u?.input ?? "",
            outputTokens: u?.output ?? "",
          });
        }
      }

      const icon = aggregatedMatch ? "✅" : "❌";
      const flake = verdictFlake ? " 🎲 flake" : "";
      console.log(
        `${icon} ${meta.id} aggregated_match=${aggregatedMatch} (expected ${expectedPassed}, got ${aggregatedPassed})${flake}`
      );
    } finally {
      if (serveProc?.pid) {
        try {
          serveProc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
      cleanAgentArtifacts();
      await resetWorkspaceToMain();
    }
  }

  if (didStash) {
    const pop = await runCmd("git", ["stash", "pop"], { cwd: ROOT });
    if (pop.code !== 0) {
      console.warn("git stash pop reported an issue — resolve manually if needed:\n", pop.stderr);
    }
  }

  const header = [
    "case_id",
    "run_n",
    "runs_total",
    "expected_passed",
    "got_passed",
    "match",
    "aggregated_passed",
    "aggregated_match",
    "bugs_count",
    "first_bug_title",
    "duration_ms_case",
    "input_tokens",
    "output_tokens",
  ];

  const lines = [
    header.join(","),
    ...rows.map((r) =>
      [
        escapeCsv(r.caseId),
        r.runIndex,
        r.runsTotal,
        r.expectedPassed,
        r.gotPassed,
        r.match,
        r.aggregatedPassed,
        r.aggregatedMatch,
        r.bugsCount,
        escapeCsv(r.firstBugTitle),
        r.durationMsCase || "",
        r.inputTokens === "" ? "" : r.inputTokens,
        r.outputTokens === "" ? "" : r.outputTokens,
      ].join(",")
    ),
  ];
  mkdirSync(join(ROOT, "evals"), { recursive: true });
  writeFileSync(RESULTS_CSV, lines.join("\n") + "\n", "utf8");
  console.log(`\nWrote ${RESULTS_CSV}`);

  console.log("\n── Summary (aggregated_match vs expected) ──");
  console.log(`Bug-fail cases — TP (expected fail, got fail): ${tp}`);
  console.log(`Bug-fail cases — FN (expected fail, got pass): ${fn}`);
  console.log(`Clean cases — TN (expected pass, got pass): ${tn}`);
  console.log(`Clean cases — FP (expected pass, got fail): ${fp}`);
  console.log(`Cases with per-run verdict flake: ${flakeCases}`);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
