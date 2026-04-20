# PR browser agent — local eval harness

Repeatable cases under `evals/cases/` measure whether prompts / `PR_AGENT_RUNS` / models **catch injected bugs** instead of relying on one-off PRs.

## Prerequisites

- Clean or stashed working tree on `main` (the harness runs `git reset --hard` between cases).
- `OPENROUTER_API_KEY` in the environment (same as `npm run agent:pr-browser`).
- Dependencies installed (`npm install`).

## Run

```bash
export OPENROUTER_API_KEY=…   # required
npm run evals
```

Optional:

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `EVALS_N` | `2` | Passed to `PR_AGENT_RUNS` — LLM verdict passes per case (same evidence, conservative aggregation). |
| `EVALS_PORT` | `9333` | Static server port. |
| `BASE_URL` | `http://127.0.0.1:$EVALS_PORT` | Preview URL for the agent. |
| `EVALS_CASES` | _(empty)_ | Comma-separated case **directory** names or prefixes, e.g. `01-benign-style-tweak,02-weather-dead-handler`. |
| `EVALS_GIT_STASH` | `tracked` | `tracked` — `git stash push` (tracked changes only, **recommended** so uncommitted `evals/` is not stashed away). `all` / `untracked` — `git stash push -u` (only after `evals/` is committed). `none` — no stash. |

Output: `evals/results.csv` (gitignored). Columns include per-run `got_passed`, `aggregated_passed` / `aggregated_match`, optional token counts parsed from agent stderr, and a short console summary (TP/TN/FP/FN + flake count when per-run verdicts disagree).

## Cases

| Directory | Intent |
| --------- | ------ |
| `01-benign-style-tweak` | Safe eyebrow copy — expect pass. |
| `02-weather-dead-handler` | Weather handler never settles — expect fail. |
| `03-cat-bg-color-text` | Cat fact text same color as card — expect fail (visual). |
| `04-unrelated-noise` | Benign code + vague PR prose — expect pass. |
| `05-scope-guard` | Truncated diff vs full tree (inert counter “+”) — label expects pass; **may be flaky**. |
| `06-fx-wrong-json-field` | Reads `rates.EUR` instead of `PLN` — expect fail. |
| `07-counter-minus-inert` | Minus button no-op — expect fail. |
| `08-fx-fetch-hang` | FX fetch never completes — expect fail. |
| `09-weather-temp-opacity-visual` | Temperature line `opacity: 0` after success — expect fail (visual). |
| `10-hero-highlight-benign` | Highlight title wording only — expect pass. |
| `11-pr-claim-fx-border-mismatch` | PR claims gold border on FX card; diff only touches intro copy — expect fail (description vs UI). |
| `12-index-html-title-benign` | `<title>` in `index.html` only — expect pass. |
| `13-cat-wrong-json-key` | Parses `text` instead of `fact` from catfact — expect fail. |
| `14-footer-copy-benign` | Footer micro-copy — expect pass. |
| `15-demo-lede-low-contrast` | Very pale demo intro text — expect fail (visual). |

Follow-up: dual-bug case, CI `workflow_dispatch`.

## Case layout

Each case includes:

- `case.json` — `id`, `notePl`, `expected.qaPassed` (+ optional `minBugs` / `kindAtLeastOne` for future checks).
- `change.patch` — `git apply` on current `main`.
- `pr-context/` — `pr.json`, `files.txt`, `diff.patch` (what the agent reads; may be a **subset** of `change.patch` for scope tests).

## Relationship to CI

This does **not** run in GitHub Actions in the current MVP. It does not modify `scripts/pr-browser-agent.ts`; it shells out to the same script as production.
