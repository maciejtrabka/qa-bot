# PR browser agent — przeniesienie do innego repozytorium

Krótki przewodnik: co skopiować, co skonfigurować na GitHubie i jak to się ma do **GitHub Marketplace**.

Szczegóły działania agenta: [`PR-AGENT-QA.md`](PR-AGENT-QA.md).

## Scaffold: `npm create pr-browser-agent` (najprościej)

Z rootu **docelowego** projektu (tam gdzie jest `package.json`):

```bash
npm create pr-browser-agent@latest
```

Alternatywnie: `npx create-pr-browser-agent@latest`. Nadpisanie istniejących plików szablonu: dodaj `-- --force`.

Pakiet kopiuje workflow, patch Stagehanda, prompt, `scripts/pr-browser-agent.ts`, `tsconfig.scripts.json`, opcjonalnie skill Cursor **`.cursor/skills/pr-mvp-smoke-test/SKILL.md`** (playbook pod testowy PR z agentem), scala `package.json` (devDependencies + skrypty) i dopisuje blok do `.gitignore`. **Nie kopiuje strony demo.**

Kod źródłowy scaffoldu: katalog [`packages/create-pr-browser-agent`](../packages/create-pr-browser-agent) w tym repo. Lokalny test bez publikacji na npm:

```bash
npm create ./packages/create-pr-browser-agent
```

(Ścieżka względem checkoutu `qa-bot`.)

**Publikacja na npm** (jednorazowo, z podwyższonym semver): w `packages/create-pr-browser-agent` uruchom `npm publish --access public` (wymaga konta npm i zalogowania).

## Minimalny zestaw plików do skopiowania

| Ścieżka | Po co |
| -------- | ----- |
| `.github/workflows/pr-browser-agent.yml` | Workflow CI (build → serve → agent → komentarz PR / artefakt) |
| `scripts/pr-browser-agent.ts` | Logika agenta (Stagehand + OpenRouter) |
| `tsconfig.scripts.json` | Typecheck dla skryptów Node (albo równoważna konfiguracja w docelowym `tsconfig`) |
| `patches/@browserbasehq+stagehand+3.2.1.patch` | Patch Stagehand pod OpenRouter (`patch-package`) |
| `pr-agent-qa-prompt.md` | Domyślny prompt QA (możesz zmienić nazwę — wtedy dopasuj workflow i `PR_AGENT_PROMPT_FILE`) |

**W `package.json` docelowego projektu** muszą być m.in.:

- Skrypt: `"agent:pr-browser": "tsx scripts/pr-browser-agent.ts"`
- `"postinstall": "patch-package"` (żeby patch się aplikował po `npm install`)
- Zależności dev zgodne z tym repozytorium: `@browserbasehq/stagehand`, `@ai-sdk/openai-compatible`, `ai`, `playwright`, `tsx`, `typescript`, `zod`, `deepmerge`, `patch-package`, `serve`, `@types/node` (oraz wersje dopasowane do reszty projektu)

Workflow zakłada:

- `npm run build` buduje statyczną witrynę do **`dist/`**
- `npx serve dist -l 9333` serwuje ją lokalnie na runnerze
- `gh` (GitHub CLI) jest dostępny na `ubuntu-latest` — używany do `pr view` / `pr diff` / `pr comment`

Jeśli docelowy projekt ma inny katalog wyjścia (np. `build/`) albo inny port — **edytuj** kroki „Build site”, „Start static server” i env `BASE_URL` w workflow oraz domyślny `BASE_URL` w skrypcie (lub tylko env w workflow).

## Sekrety i zmienne w GitHub (Settings → Secrets and variables → Actions)

| Nazwa | Typ | Wymagane | Opis |
| ----- | --- | -------- | ----- |
| `OPENROUTER_API_KEY` | **Secret** | Tak | Klucz API OpenRouter |
| `STAGEHAND_MODEL` | Variable | Nie | Slug modelu OpenRouter; domyślnie w kodzie jest m.in. `anthropic/claude-sonnet-4.6` |
| `PR_AGENT_QA_PROMPT` | Variable | Nie | Jeśli ustawione — **nadpisuje** plik promptu z repo (`PR_AGENT_PROMPT` w jobie) |
| `PR_AGENT_VISION` | Variable | Nie | `0` — werdykt bez screenshotów (tylko `extract`; modele bez vision) |
| `PR_AGENT_RUNS` | Variable | Nie | Domyślnie `2` w skrypcie; `1` szybsze przy strojeniu promptu |

Workflow przekazuje też `OPENROUTER_HTTP_REFERER` (identyfikacja w OpenRouter).

**PR z forka:** sekrety zwykle **nie** są dostępne — sensowny zakres to PR-y z tego samego repo.

## Branch protection

Po pierwszym uruchomieniu joba na `main` ustaw wymagany status check **`pr_browser_agent`** (nazwa **joba** w YAML). Szczegóły: [`PR-AGENT-QA.md`](PR-AGENT-QA.md) (sekcja o tym, że check może nie być widoczny zanim job się nie wykona).

## Czy to może być „akcja z GitHub Marketplace”?

- **Tak w sensie technicznym**, ale obecny projekt to **cały workflow** (build aplikacji + serwer statyczny + Playwright + skrypt TS + patch). Na Marketplace zwykle publikuje się **pojedynczą akcję** (`action.yml` + Docker albo composite steps) albo **reusable workflow** w osobnym repozytorium.
- **Najprostsze opcje ponownego użycia bez Marketplace:**
  1. Skopiować pliki powyżej i dostosować build/serve (jak każdy własny workflow).
  2. W organizacji trzymać **reusable workflow** w jednym repo i w innych repo wywoływać `uses: org/repo/.github/workflows/....yml@ref` (wymaga dopisania `workflow_call` i parametrów).
  3. Submoduł / monorepo ze wspólnym `scripts/pr-browser-agent.ts`.

**Marketplace** dodatkowo wymaga m.in. repozytorium publicznego (dla darmowej publikacji), `action.yml`, README dla użytkowników, tagów semver — i przy ciężkich zależnościach często **obraz Dockera**. To jest osobny nakład w porównaniu do „wklejenia workflow do repo aplikacji”.

## `.gitignore` w docelowym repo

Warto dodać (jeśli jeszcze nie ma):

```gitignore
pr-context/
pr-agent*.txt
pr-agent*.md
pr-agent*.png
pr-agent*.log
```

Pliki `pr-agent-*` generuje skrypt w czasie pracy; `pr-context/` tworzy workflow na CI.
