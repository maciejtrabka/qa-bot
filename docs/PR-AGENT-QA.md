# PR browser agent — jak to działa i jak testować

## Cel

Przy **pull requeście do `main`** workflow **„PR browser agent”** uruchamia agenta **Stagehand** w trybie **LOCAL** (Chromium na runnerze GitHub Actions) z modelem przez **OpenRouter**. Agent wykonuje krótką **eksplorację** przycisku opisanego jako dodawanie tekstu „Hello world” pod przyciskiem, a potem **twarda weryfikacja DOM** sprawdza, czy po kliknięciu w `[data-testid="cta-primary"]` w `[data-testid="hello-output"]` faktycznie pojawia się **Hello world**.

Jeśli coś jest nie tak (np. zepsuty handler w PR), job kończy się **niepowodzeniem** — możesz wymusić **blokadę merge** przez branch protection — oraz workflow dodaje **komentarz na PR** z fragmentem logu.

## Pliki w repo

| Element | Ścieżka |
| -------- | -------- |
| Strona + przycisk | [`index.html`](../index.html) |
| Agent (LLM + DOM) | [`scripts/pr-browser-agent.ts`](../scripts/pr-browser-agent.ts) |
| Workflow | [`.github/workflows/pr-browser-agent.yml`](../.github/workflows/pr-browser-agent.yml) |

## Sekrety i zmienne

| Nazwa | Gdzie | Opis |
| ----- | ----- | ----- |
| `OPENROUTER_API_KEY` | GitHub → Settings → Secrets and variables → Actions | Wymagane do wywołań LLM (Stagehand). |
| `STAGEHAND_MODEL` | (Opcjonalnie) Actions **Variables** | Pełny slug modelu, np. `openai/meta-llama/llama-3.3-70b-instruct:free`. Puste = domyślny model w skrypcie. |

**PR z forka** zwykle **nie** dostaje sekretów — MVP zakłada PR-y **z tego samego repozytorium**.

## Blokada merge (wymagany status check)

1. Repo → **Settings** → **Branches** → **Branch protection rule** dla `main`.
2. Włącz **Require status checks to pass before merging**.
3. Wyszukaj i zaznacz check o nazwie **`pr_browser_agent`** (to jest **nazwa joba** w workflow „PR browser agent”). W UI często widać **„PR browser agent / pr_browser_agent”**.

Dopóki reguła nie jest włączona, czerwony job **nie blokuje** merge automatycznie — tylko ostrzega.

### Dlaczego GitHub nie pokazuje `pr_browser_agent` na liście?

W wyszukiwarce checków jest podpowiedź w stylu **„w ostatnim tygodniu”** — **dopóki job choć raz się nie wykona**, ten status **nie pojawi się** do wyboru.

Zrób jedno z dwóch (wystarczy jedno udane lub nieudane uruchomienie joba):

1. **Ręcznie:** po zmergowaniu workflow do `main` wejdź w **Actions** → workflow **„PR browser agent”** → **Run workflow** (trigger **`workflow_dispatch`**), uruchom na domyślnej gałęzi. Po zakończeniu runu odśwież stronę branch protection i ponownie wyszukaj `pr_browser_agent`.
2. **Przez PR:** otwórz lub zaktualizuj **PR do `main`**, żeby odpalił się ten sam workflow.

Plik workflow w repo jest poprawny — kluczowe jest **mieć go już na `main`** i **mieć choć jeden run**.

## Jak zrobić „zły” PR testowy (dla agenta)

1. **Opis PR:** napisz np. że zmieniasz kolor przycisku (żeby recenzent widział intencję kosmetyczną).
2. W **CSS** (np. [`styles.css`](../styles.css)) zmień `--accent` lub tło `.btn` — wyraźna zmiana wizualna.
3. W **JS w `index.html`** zepsij handler `click` tak, żeby **nie** dodawał już `Hello world` do `[data-testid="hello-output"]` (np. pusty handler, zły selektor, `preventDefault` bez logiki).

Oczekiwany efekt: job **`pr_browser_agent`** → **failure** + komentarz na PR.

## Lokalnie

```bash
npm ci
npx playwright install chromium
npx serve . -l 9333
# drugi terminal:
cp .env.example .env   # uzupełnij OPENROUTER_API_KEY
export $(grep -v '^#' .env | xargs)   # albo ręcznie export OPENROUTER_API_KEY=...
npm run agent:pr-browser
```

`BASE_URL` domyślnie to `http://127.0.0.1:9333`.

## Uwagi

- Node na runnerze: **20.x** (zgodnie z `engines` Stagehand; unikaj 21.x na CI).
- Logi przy błędzie: artifact **`pr-agent-logs`** (`pr-agent.log`, `pr-agent-failure.txt`).
