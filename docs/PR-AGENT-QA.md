# PR browser agent — jak to działa i jak testować

## Cel

Przy **pull requeście do `main`** workflow **„PR browser agent”** zapisuje kontekst PR do **`pr-context/`**, potem uruchamia **Stagehand** (LOCAL) + **OpenRouter**. **Co dokładnie testować** definiujesz **promptem**:

- domyślnie plik **[`pr-agent-qa-prompt.md`](../pr-agent-qa-prompt.md)** w root repozytorium (wersjonowany razem z kodem), albo
- zmienna repozytorium **`PR_AGENT_QA_PROMPT`** (treść trafia do env `PR_AGENT_PROMPT` i **nadpisuje** plik), albo
- przy **`workflow_dispatch`**: pole **prompt_file** (ścieżka do innego pliku markdown z promptem).

Krok **`act`** wykonuje instrukcje z prompta (+ kontekst PR). Krok **`extract`** zwraca strukturalny werdykt **`qaPassed`** — jeśli model ustawi `false` (albo wystąpi błąd), job **fail** → możliwa **blokada merge** + **komentarz na PR** z logiem.

**Uwaga:** bramka opiera się na **ocenie LLM**, nie na osobnym skrypcie Playwright z twardymi selektorami. Możesz dopisać w promptcie konkretne selektory / kroki, żeby model był bardziej deterministyczny.

## Pliki w repo

| Element | Ścieżka |
| -------- | -------- |
| Strona + przycisk | [`index.html`](../index.html) |
| Agent (LLM + DOM) | [`scripts/pr-browser-agent.ts`](../scripts/pr-browser-agent.ts) |
| Workflow | [`.github/workflows/pr-browser-agent.yml`](../.github/workflows/pr-browser-agent.yml) |
| Kontekst PR (generowany na CI / lokalnie) | `pr-context/pr.json`, `pr-context/files.txt`, `pr-context/diff.patch` (katalog w `.gitignore`) |
| Prompt QA (commitowany) | [`pr-agent-qa-prompt.md`](../pr-agent-qa-prompt.md) |

## Sekrety i zmienne

| Nazwa | Gdzie | Opis |
| ----- | ----- | ----- |
| `OPENROUTER_API_KEY` | GitHub → Settings → Secrets and variables → Actions | Wymagane do wywołań LLM (Stagehand). |
| `STAGEHAND_MODEL` | (Opcjonalnie) Actions **Variables** | Pełny slug OpenRouter, np. `meta-llama/llama-3.3-70b-instruct:free` (darmowy, bywa **429**). Puste = domyślny model w skrypcie. |
| `PR_AGENT_QA_PROMPT` | (Opcjonalnie) Actions **Variables** | Pełny tekst prompta QA — jeśli ustawiony, **zastępuje** plik `pr-agent-qa-prompt.md`. |

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

**Tylko na gałęzi PR (nie na `main`):** poniższe kroki wykonuj na **osobnej gałęzi** z otwartym **pull requestem do `main`**. Po teście **zamknij PR bez merge** albo cofnij zmiany — **`main` w repozytorium ma nadal** poprawne `'Hello world'` w `index.html`. Na `main` commitujemy wyłącznie **dokumentację i prompt QA** (jak ten plik), a nie „zepsutą” stronę.

1. **Opis PR:** napisz np. że zmieniasz kolor przycisku (żeby recenzent widział intencję kosmetyczną).
2. W **CSS** (np. [`styles.css`](../styles.css)) zmień `--accent` lub tło `.btn` — wyraźna zmiana wizualna.
3. W **JS w `index.html`** zostaw handler działający (nadal dodaje akapit do `[data-testid="hello-output"]`), ale zmień **`p.textContent`** z `'Hello world'` na **losowy ciąg znaków** bez tej frazy, np. `'asdasdansidufwe'`. To symuluje regresję treści bez „wyzerowania” UI — coś się pojawia, ale **nie** jest to oczekiwany tekst.

Oczekiwany efekt: job **`pr_browser_agent`** → zwykle **failure** + komentarz na PR, gdy model z diffa i UI uzna regresję (np. zamiast sensownego **Hello world** widać losowy ciąg). Przy bardzo ogólnym prompcie werdykt może być mniej przewidywalny — wtedy doprecyzuj prompt albo użyj **`PR_AGENT_QA_PROMPT`** ze sztywniejszymi krokami.

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
Opcjonalnie lokalnie: `PR_AGENT_PROMPT_FILE=inny-plik.md` albo `PR_AGENT_PROMPT='...'` (nadpisuje plik).

## Uwagi

- Node na runnerze: **20.x** (ustawione w workflow; Stagehand wymaga współczesnego Node — trzymaj się wersji z joba, unikaj eksperymentalnych majorów na CI).
- Logi przy błędzie: artifact **`pr-agent-logs`** (`pr-agent.log`, `pr-agent-failure.txt`).
