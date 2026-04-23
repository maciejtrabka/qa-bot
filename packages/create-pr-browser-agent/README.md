# create-pr-browser-agent

Scaffolds the **PR browser agent** (GitHub Actions + Stagehand + OpenRouter) into your repo. No demo app.

Adds: workflow, agent script, Stagehand patch, default QA prompt, merges `package.json` and `.gitignore`. Also drops the Cursor skill `.cursor/skills/pr-mvp-smoke-test/SKILL.md` (optional).

## Usage

```bash
npm create pr-browser-agent@latest
```

Flags: `-- --force` (overwrite), `-- --dry-run`.

After scaffolding, run `npm install` and make sure `npm run build` outputs a static site into `dist/`. The workflow serves it at `http://127.0.0.1:9333`. Edit the workflow if your build dir or port differs.

## GitHub configuration

| | Name | Required | Notes |
|---|------|----------|--------|
| Secret | `OPENROUTER_API_KEY` | **Yes** | OpenRouter API key. |
| Variable | `STAGEHAND_MODEL` | No | OpenRouter model id. Default: `anthropic/claude-sonnet-4.6`. |
| Variable | `PR_AGENT_QA_PROMPT` | No | Overrides `pr-agent-qa-prompt.md`. |
| Variable | `PR_AGENT_VISION` | No | `0` = text-only verdict. |
| Variable | `PR_AGENT_RUNS` | No | Verdict runs. Default `2`. |
| Variable | `PR_AGENT_CONTRAST_SCAN` | No | `0` disables the contrast table. |
| Variable | `PR_AGENT_CONTRAST_STRICT` | No | `1` fails the job on near-1.0 text/background pairs. |

Fork PRs usually do not get secrets — gate on same-repo branches.

## Notes

- Hosted previews (Vercel etc.) are **not** configured by default. The workflow builds and serves `dist/` on the Actions runner. Point at an external URL? Edit the workflow yourself.
- Source and full docs: [qa-bot](https://github.com/maciejtrabka/qa-bot) · [PR-AGENT-PORTABLE-SETUP.md](https://github.com/maciejtrabka/qa-bot/blob/main/docs/PR-AGENT-PORTABLE-SETUP.md).
