# qa-bot

Statyczna strona testowa i workflow **PR browser agent**: przy PR do `main` uruchamiany jest **Stagehand** (LOCAL) + **OpenRouter**, a potem twarda weryfikacja, czy przycisk dodaje **Hello world** pod spodem.

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
