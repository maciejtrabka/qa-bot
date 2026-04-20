# PR browser agent — jak to działa i jak testować

## Cel

**Bramka `pr_browser_agent` dotyczy pull requestów do `main`** (tam agent testuje zmiany i może zablokować merge). Iteracja nad samym workflow / promptem / skryptem agenta bywa **commitowana bezpośrednio na `main`** bez tej samej blokady — intencja MVP i polityka: lokalny **`AGENTS.md`** (gitignored) oraz skrót w **[`README.md`](../README.md)**.

Przy **pull requeście do `main`** workflow **„PR browser agent”** zapisuje kontekst PR do **`pr-context/`**, potem uruchamia **Stagehand** (LOCAL) + **OpenRouter**. **Co dokładnie testować** definiujesz **promptem**:

- domyślnie plik **[`pr-agent-qa-prompt.md`](../pr-agent-qa-prompt.md)** w root repozytorium (wersjonowany razem z kodem), albo
- zmienna repozytorium **`PR_AGENT_QA_PROMPT`** (treść trafia do env `PR_AGENT_PROMPT` i **nadpisuje** plik), albo
- przy **`workflow_dispatch`**: pole **prompt_file** (ścieżka do innego pliku markdown z promptem).

Krok **`act`** wykonuje instrukcje z prompta (+ kontekst PR: tytuł, opis, pliki, diff) używając **drzewa dostępności (a11y) / DOM** jako źródła prawdy. W tle skrypt podpina się też do Playwrightowych zdarzeń strony — zbiera `console.error` / `console.warn`, niezłapane wyjątki, failed requesty oraz odpowiedzi HTTP ≥ 400 (blok **Console / network capture**). Krok werdyktu robi **dwa screenshoty** gotowej strony (viewport + full-page) i wysyła je razem z promptem QA, a11y snapshotem **oraz zebraną diagnostyką** do modelu wizyjnego — zwraca strukturalny werdykt **`qaPassed`**. Dzięki temu agent łapie też **regresje czysto wizualne** (np. tekst w kolorze tła, nachodzące elementy, ukryty przycisk) oraz **błędy runtime** (konsola / sieć), których sam DOM nie zdradzi. Screenshoty i `pr-agent-diagnostics.txt` trafiają do artefaktu **`pr-agent-logs`** (dostępne w UI Actions).

Jeśli model ustawi `qaPassed: false` (albo wystąpi błąd), job **fail** → możliwa **blokada merge** + **komentarz na PR** (plik `pr-agent-pr-comment.md` z krótkim raportem po angielsku: *Summary*, *Steps to reproduce*, *Expected / Actual result*; bez wklejania całego prompta ani diffa).

**Uwaga:** bramka opiera się wyłącznie na **eksploracji strony przez agenta LLM** zgodnie z promptem — nie ma osobnego deterministycznego testu DOM przed `act`. Jeśli chcesz wyłączyć krok wizyjny (np. dla modelu bez vision), ustaw **`PR_AGENT_VISION=0`** — wtedy werdykt idzie przez Stagehand `extract()` (tekst-only).

**Zakres testów:** domyślny **[`pr-agent-qa-prompt.md`](../pr-agent-qa-prompt.md)** jest **uniwersalny** (bez opisu konkretnej witryny): agent ma testować **intensywnie okolicę zmiany z PR** (pliki + diff), a **nie** robić pełnej regresji całej aplikacji. Skrypt [`scripts/pr-browser-agent.ts`](../scripts/pr-browser-agent.ts) dopina to w `act` / `extract` (m.in. `whatYouChecked` bez listy odwiedzonych tras).

## Pliki w repo

| Element | Ścieżka |
| -------- | -------- |
| Witryna React (Vite) + CTA | [`src/App.tsx`](../src/App.tsx), [`src/index.css`](../src/index.css), [`index.html`](../index.html) (entry Vite) |
| Agent (LLM + DOM) | [`scripts/pr-browser-agent.ts`](../scripts/pr-browser-agent.ts) |
| Workflow | [`.github/workflows/pr-browser-agent.yml`](../.github/workflows/pr-browser-agent.yml) |
| Kontekst PR (generowany na CI / lokalnie) | `pr-context/pr.json`, `pr-context/files.txt`, `pr-context/diff.patch` (katalog w `.gitignore`) |
| Prompt QA (commitowany) | [`pr-agent-qa-prompt.md`](../pr-agent-qa-prompt.md) |

## Sekrety i zmienne

| Nazwa | Gdzie | Opis |
| ----- | ----- | ----- |
| `OPENROUTER_API_KEY` | GitHub → Settings → Secrets and variables → Actions | Wymagane do wywołań LLM (Stagehand + werdykt wizyjny). |
| `STAGEHAND_MODEL` | (Opcjonalnie) Actions **Variables** | Pełny slug OpenRouter. Domyślnie `anthropic/claude-sonnet-4.6` (obsługuje vision — wymagane do werdyktu ze screenshotami). Model tekst-only (np. `meta-llama/llama-3.3-70b-instruct:free`) zadziała **tylko** przy `PR_AGENT_VISION=0`. |
| `PR_AGENT_QA_PROMPT` | (Opcjonalnie) Actions **Variables** | Pełny tekst prompta QA — jeśli ustawiony, **zastępuje** plik `pr-agent-qa-prompt.md`. |
| `PR_AGENT_VISION` | (Opcjonalnie) Actions **Variables** lub env lokalny | `0` wyłącza werdykt wizyjny (fallback do `stagehand.extract()`). Domyślnie włączone. |

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

**Tylko na gałęzi PR (nie na `main`):** poniższe kroki wykonuj na **osobnej gałęzi** z otwartym **pull requestem do `main`**. Po teście **zamknij PR bez merge** albo cofnij zmiany — **`main` w repozytorium ma nadal** działające demo w [`src/App.tsx`](../src/App.tsx) (pogoda / fakt / licznik / kurs). Na `main` commitujemy wyłącznie **dokumentację i prompt QA** (jak ten plik), a nie „zepsutą” stronę.

1. **Opis PR:** napisz np. że zmieniasz kolor przycisku (żeby recenzent widział intencję kosmetyczną).
2. W **CSS** (np. [`src/index.css`](../src/index.css)) zmień `--accent` lub tło `.btn` — wyraźna zmiana wizualna.
3. W **React** ([`src/App.tsx`](../src/App.tsx)) wprowadź ukrytą regresję, np.:
   - zły URL w `fetch` (Open-Meteo / catfact / Frankfurter), żeby zawsze był błąd w `[data-testid="weather-output"]` itd.;
   - lub zła ścieżka w `response.json()` (np. czytasz `j.wrong` zamiast `j.current.temperature_2m`), żeby temperatura była pusta mimo sukcesu sieci;
   - albo `setSlotsLeft((n) => n)` zamiast `n + 1` przy plusie — licznik przestaje rosnąć.

Oczekiwany efekt: job **`pr_browser_agent`** → zwykle **failure** + komentarz na PR, gdy model z diffa i UI uzna regresję. Przy bardzo ogólnym prompcie werdykt może być mniej przewidywalny — wtedy doprecyzuj prompt albo użyj **`PR_AGENT_QA_PROMPT`** ze sztywniejszymi krokami.

Jeśli zamiast regresji logiki wolisz sprawdzić „martwy” przycisk (np. literówka w `data-testid` kontenera wyniku), **LLM może ten scenariusz przeoczyć** przy ogólnym prompcie i opisie „tylko kolor” — wtedy zaostrz instrukcje w promptcie QA (klik w CTA, oczekiwany efekt w DOM, porównanie z diffem).

## Lokalnie

```bash
npm ci
npm run build
npx playwright install chromium
npx serve dist -l 9333
# drugi terminal:
cp .env.example .env   # uzupełnij OPENROUTER_API_KEY
export $(grep -v '^#' .env | xargs)   # albo ręcznie export OPENROUTER_API_KEY=...
npm run agent:pr-browser
```

`BASE_URL` domyślnie to `http://127.0.0.1:9333`.  
Opcjonalnie lokalnie: `PR_AGENT_PROMPT_FILE=inny-plik.md` albo `PR_AGENT_PROMPT='...'` (nadpisuje plik).

## Uwagi

- Node na runnerze: **20.x** (ustawione w workflow; Stagehand wymaga współczesnego Node — trzymaj się wersji z joba, unikaj eksperymentalnych majorów na CI).
- Logi przy błędzie: artifact **`pr-agent-logs`** (`pr-agent.log`, `pr-agent-failure.txt`, opcjonalnie `pr-agent-pr-comment.md` — ta sama treść co komentarz na PR, plus screenshoty `pr-agent-screenshot-viewport.png` / `pr-agent-screenshot-fullpage.png` i `pr-agent-diagnostics.txt` z zebranymi błędami konsoli / sieci).
