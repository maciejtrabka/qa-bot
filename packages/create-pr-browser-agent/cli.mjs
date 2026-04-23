#!/usr/bin/env node
/**
 * create-pr-browser-agent — copies workflow, agent script, patch, prompt; merges package.json + .gitignore.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = join(__dirname, "templates");

/** Dev deps required by scripts/pr-browser-agent.ts (keep in sync with qa-bot package.json). */
const AGENT_DEV_DEPS = {
  "@ai-sdk/openai-compatible": "^1.0.36",
  "@browserbasehq/stagehand": "^3.2.1",
  "@types/node": "^25.0.3",
  ai: "^5.0.179",
  deepmerge: "^4.3.1",
  "patch-package": "^8.0.1",
  playwright: "^1.59.1",
  serve: "^14.2.4",
  tsx: "^4.21.0",
  typescript: "~5.7.2",
  zod: "^4.3.6",
};

const TEMPLATE_FILES = [
  ".github/workflows/pr-browser-agent.yml",
  "patches/@browserbasehq+stagehand+3.2.1.patch",
  "pr-agent-qa-prompt.md",
  "tsconfig.scripts.json",
  "scripts/pr-browser-agent.ts",
  ".cursor/skills/pr-mvp-smoke-test/SKILL.md",
];

const GITIGNORE_BLOCK = `
# PR browser agent (create-pr-browser-agent)
pr-context/
pr-agent*.txt
pr-agent-pr-comment.md
pr-agent-screenshot-viewport.png
pr-agent-screenshot-fullpage.png
pr-agent-verdict-raw.txt
pr-agent-diagnostics.txt
pr-agent-bug-*.png
pr-agent.log
`;

function parseArgs(argv) {
  let force = false;
  let dryRun = false;
  for (const a of argv) {
    if (a === "--force" || a === "-f") force = true;
    if (a === "--dry-run") dryRun = true;
    if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return { force, dryRun };
}

function printHelp() {
  console.log(`create-pr-browser-agent

Scaffold the PR browser agent into the current directory (workflow, patch, prompt, script, package.json merge).

Usage:
  npm create pr-browser-agent@latest
  npx create-pr-browser-agent@latest
  npx create-pr-browser-agent@latest -- --force

Options:
  --force, -f   Overwrite existing template files
  --dry-run     Print actions without writing files
  --help, -h    Show this message
`);
}

function copyTree(rel, targetRoot, { force, dryRun }) {
  const src = join(TEMPLATE_ROOT, rel);
  const dest = join(targetRoot, rel);
  if (!existsSync(src)) {
    throw new Error(`Internal error: missing template ${rel}`);
  }
  if (existsSync(dest) && !force) {
    console.log(`skip (exists): ${rel}  (use --force to overwrite)`);
    return "skip";
  }
  const dir = dirname(dest);
  if (!dryRun) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(src, dest);
  }
  console.log(`${dryRun ? "[dry-run] would copy" : "copy"}: ${rel}`);
  return "ok";
}

function mergePackageJson(targetRoot, dryRun) {
  const path = join(targetRoot, "package.json");
  if (!existsSync(path)) {
    console.warn(
      "No package.json in this directory — create one first, then re-run, or add agent files manually.",
    );
    return;
  }
  const raw = readFileSync(path, "utf8");
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    console.error("package.json is not valid JSON — fix it and re-run.");
    process.exit(1);
  }

  pkg.devDependencies = pkg.devDependencies ?? {};
  let added = 0;
  for (const [name, ver] of Object.entries(AGENT_DEV_DEPS)) {
    if (pkg.devDependencies[name] == null) {
      pkg.devDependencies[name] = ver;
      added++;
    }
  }
  if (added) console.log(`package.json: added ${added} devDependencies (skipped existing keys).`);

  pkg.scripts = pkg.scripts ?? {};

  const patchCmd = "patch-package";
  if (!pkg.scripts.postinstall) {
    pkg.scripts.postinstall = patchCmd;
    console.log(`package.json: set scripts.postinstall = "${patchCmd}"`);
  } else if (!String(pkg.scripts.postinstall).includes("patch-package")) {
    pkg.scripts.postinstall = `${pkg.scripts.postinstall} && ${patchCmd}`;
    console.log(`package.json: appended patch-package to scripts.postinstall`);
  } else {
    console.log("package.json: scripts.postinstall already references patch-package — left as-is.");
  }

  const agentScript = "tsx scripts/pr-browser-agent.ts";
  if (!pkg.scripts["agent:pr-browser"]) {
    pkg.scripts["agent:pr-browser"] = agentScript;
    console.log(`package.json: set scripts["agent:pr-browser"]`);
  } else {
    console.log('package.json: scripts["agent:pr-browser"] already set — left as-is.');
  }

  const out = `${JSON.stringify(pkg, null, 2)}\n`;
  if (dryRun) {
    console.log("[dry-run] would write package.json (merged)");
    return;
  }
  writeFileSync(path, out, "utf8");
}

function mergeGitignore(targetRoot, dryRun) {
  const path = join(targetRoot, ".gitignore");
  const block = GITIGNORE_BLOCK.trimStart();
  if (!existsSync(path)) {
    if (!dryRun) writeFileSync(path, `${block}\n`, "utf8");
    console.log(`${dryRun ? "[dry-run] would create" : "create"} .gitignore with PR agent entries`);
    return;
  }
  const cur = readFileSync(path, "utf8");
  if (cur.includes("PR browser agent (create-pr-browser-agent)")) {
    console.log(".gitignore: PR agent block already present — left as-is.");
    return;
  }
  const next = `${cur.replace(/\s*$/, "")}\n${block}\n`;
  if (!dryRun) writeFileSync(path, next, "utf8");
  console.log(`${dryRun ? "[dry-run] would append" : "append"} PR agent block to .gitignore`);
}

function isPathInside(parent, candidate) {
  const p = resolve(parent);
  const c = resolve(candidate);
  return c === p || c.startsWith(p + sep);
}

function main() {
  const argv = process.argv.slice(2);
  const { force, dryRun } = parseArgs(argv);

  const targetRoot = process.cwd();
  const pkgRoot = __dirname;
  if (isPathInside(pkgRoot, targetRoot)) {
    console.error(
      "Refusing to run inside the create-pr-browser-agent package directory. Run from your app project root.",
    );
    process.exit(1);
  }

  console.log(`Scaffolding PR browser agent into:\n  ${targetRoot}\n`);

  for (const rel of TEMPLATE_FILES) {
    copyTree(rel, targetRoot, { force, dryRun });
  }

  mergePackageJson(targetRoot, dryRun);
  mergeGitignore(targetRoot, dryRun);

  console.log(`
Next steps:
  1. npm install
  2. GitHub → Settings → Secrets and variables → Actions → add secret OPENROUTER_API_KEY
  3. Optional Variables: STAGEHAND_MODEL, PR_AGENT_QA_PROMPT, PR_AGENT_RUNS, PR_AGENT_VISION
  3a. If the PR change area is behind a login, add Secrets PR_AGENT_LOGIN_USER and PR_AGENT_LOGIN_PASSWORD
      (agent fills the form via Stagehand/CDP; password never leaves the browser).
      Optional overrides as Variables: PR_AGENT_LOGIN_URL, PR_AGENT_LOGIN_{USER,PASSWORD,SUBMIT,SUCCESS}_SELECTOR,
      PR_AGENT_LOGIN_SUCCESS_URL_INCLUDES, PR_AGENT_LOGIN_STRICT. See docs/PR-AGENT-QA.md.
  4. Ensure "npm run build" outputs a static site — workflow auto-detects dist/, build/, out/, or public/ and serves it on port 9333
  4a. Optional: create .nvmrc to pin Node version (workflow reads it; falls back to Node 20 if missing)
  5. Commit the new files and open a PR to main — branch protection can require check "pr_browser_agent"

Docs: https://github.com/maciejtrabka/qa-bot/blob/main/docs/PR-AGENT-PORTABLE-SETUP.md
`);
  if (dryRun) console.log("(dry-run: no files were written except skipped merges)\n");
}

main();
