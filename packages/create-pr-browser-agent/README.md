# create-pr-browser-agent

Scaffolds the **PR browser agent** (GitHub Actions + Stagehand + OpenRouter) into your repo: workflow, agent script, Stagehand patch, default QA prompt, `package.json` and `.gitignore` merge. **No demo app.**

Also adds the **Cursor skill** `.cursor/skills/pr-mvp-smoke-test/SKILL.md` — a playbook for crafting a deliberate PR (benign tweak + hidden visual + functional bug) to exercise `pr_browser_agent`. Optional if you do not use Cursor.

Source: [qa-bot](https://github.com/maciejtrabka/qa-bot).

## Usage

```bash
npm create pr-browser-agent@latest
# or: npx create-pr-browser-agent@latest
```

- Overwrite existing files: `npx create-pr-browser-agent@latest -- --force`
- Dry run: `npx create-pr-browser-agent@latest -- --dry-run`

## After scaffolding

1. `npm install` (applies the Stagehand `patch-package` patch).
2. Ensure **`npm run build`** outputs a **static** site. The default workflow serves **`dist/`** at **`http://127.0.0.1:9333`** (`serve` + `BASE_URL` in the workflow). Change the workflow if your build dir or port differs.

## GitHub configuration

| | Name | Required | Notes |
|---|------|----------|--------|
| Secret | `OPENROUTER_API_KEY` | **Yes** | OpenRouter API key for Stagehand + verdict. |
| Variable | `STAGEHAND_MODEL` | No | OpenRouter model id (default in agent: `anthropic/claude-sonnet-4.6`). Use a vision-capable model unless you set `PR_AGENT_VISION=0`. |
| Variable | `PR_AGENT_QA_PROMPT` | No | Full QA prompt text; if set, overrides `pr-agent-qa-prompt.md`. |
| Variable | `PR_AGENT_VISION` | No | `0` = text-only verdict (no screenshots). |
| Variable | `PR_AGENT_RUNS` | No | Verdict runs (default `2`). Use `1` for faster iteration. |
| Variable | `PR_AGENT_CONTRAST_SCAN` | No | `0` disables the in-browser text/background contrast table. Default: on. |
| Variable | `PR_AGENT_CONTRAST_STRICT` | No | `1` **fails** the job on near-1.0 text/background pairs even if the model passes. Default: `0` (table + prompt only). |

Optional: enable branch protection on `main` and require status check **`pr_browser_agent`**.

**Fork PRs** usually do not receive secrets; use branches on the same repo for the gate.

## Local preview (manual testing)

Not part of the scaffold, but typical flow matches CI:

```bash
npm run build
npx playwright install chromium   # once
npx serve dist -l 9333            # terminal 1
export OPENROUTER_API_KEY=...     # terminal 2
npm run agent:pr-browser
```

Default `BASE_URL` is `http://127.0.0.1:9333` (override with env if needed).

## Hosted preview (e.g. Vercel)

The **default workflow does not** use Vercel or `VERCEL_AUTOMATION_BYPASS_SECRET`. It builds and serves **`dist` on the Actions runner**. If you point the agent at an external preview URL, you must **edit the workflow** yourself (build step, `BASE_URL`, auth headers, secrets such as a bypass token—whatever your host requires). That is project-specific and not included here.

## Maintainer: updating the published package

When upstream files change in `qa-bot`, copy them into `packages/create-pr-browser-agent/templates/` (same relative paths), including `.cursor/skills/pr-mvp-smoke-test/SKILL.md` if the skill changed. Bump semver in this `package.json`, then `npm publish`. Keep **`AGENT_DEV_DEPS`** in `cli.mjs` in sync if `devDependencies` for the agent change.

## Local development of this CLI

```bash
npm create ./path/to/qa-bot/packages/create-pr-browser-agent
# or: node .../packages/create-pr-browser-agent/cli.mjs
```

More detail: [PR-AGENT-PORTABLE-SETUP.md](https://github.com/maciejtrabka/qa-bot/blob/main/docs/PR-AGENT-PORTABLE-SETUP.md).
