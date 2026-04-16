# qa-bot

Statyczna strona testowa i workflow **PR browser agent**: przy PR do `main` CI zapisuje kontekst PR w `pr-context/`, a agent **Stagehand** + **OpenRouter** wykonuje QA wg **[`pr-agent-qa-prompt.md`](pr-agent-qa-prompt.md)** (albo prompt ze zmiennej **`PR_AGENT_QA_PROMPT`** w GitHub). Wynik zaliczenia to **werdykt LLM** (`qaPassed` w `extract`). **Nie ma** osobnego jobu Playwright z `expect` w repo — Playwright jest tylko pod Chromium dla Stagehand.

**Utrzymanie / intencja MVP (lokalnie, nie w repo):** zobacz **`AGENTS.md`** w katalogu projektu — m.in. różnica między iteracją na `main` a bramką na PR.

## Szybki start (lokalnie)

```bash
npm ci
npx playwright install chromium
npx serve . -l 9333
```

W drugim terminalu ustaw `OPENROUTER_API_KEY` i uruchom:

```bash
npm run agent:pr-browser
```

Szczegóły, sekrety i branch protection: [docs/PR-AGENT-QA.md](docs/PR-AGENT-QA.md).

## Wymagany check (blokada merge)

W GitHub: Branch protection dla `main` → wymagaj statusu **`pr_browser_agent`**.
