# qa-bot

Witryna (React + Vite) do testów i workflow **PR browser agent**: przy PR do `main` CI zapisuje kontekst PR w `pr-context/`, a agent **Stagehand** + **OpenRouter** wykonuje QA wg **[`pr-agent-qa-prompt.md`](pr-agent-qa-prompt.md)** (albo prompt ze zmiennej **`PR_AGENT_QA_PROMPT`** w GitHub). Do werdyktu wchodzą m.in. screenshoty, snapshot a11y, **tabela kontrastu tekst/tło w DOM** (artefakt `pr-agent-contrast.json`) i diagnostyka konsoli. Wynik zaliczenia to **werdykt LLM** (`qaPassed`). **Nie ma** osobnego jobu Playwright z `expect` w repo — Playwright jest tylko pod Chromium dla Stagehand.

**Utrzymanie / intencja MVP (lokalnie, nie w repo):** zobacz **`AGENTS.md`** w katalogu projektu — m.in. różnica między iteracją na `main` a bramką na PR.

Szczegóły, sekrety i branch protection: [docs/PR-AGENT-QA.md](docs/PR-AGENT-QA.md).

## Inny projekt — scaffold bez kopiowania demo

Z katalogu docelowej aplikacji (root z `package.json`):

```bash
npm create pr-browser-agent@latest
```

Opis: [docs/PR-AGENT-PORTABLE-SETUP.md](docs/PR-AGENT-PORTABLE-SETUP.md).

## Wymagany check (blokada merge)

W GitHub: Branch protection dla `main` → wymagaj statusu **`pr_browser_agent`**.
