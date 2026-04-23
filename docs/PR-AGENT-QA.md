# PR browser agent — jak to działa i jak testować

## Cel

**Bramka `pr_browser_agent` dotyczy pull requestów do `main`** (tam agent testuje zmiany i może zablokować merge). Iteracja nad samym workflow / promptem / skryptem agenta bywa **commitowana bezpośrednio na `main`** bez tej samej blokady — intencja MVP i polityka: lokalny **`AGENTS.md`** (gitignored) oraz skrót w **[`README.md`](../README.md)**.

Przy **pull requeście do `main`** workflow **„PR browser agent”** zapisuje kontekst PR do **`pr-context/`**, potem uruchamia **Stagehand** (LOCAL) + **OpenRouter**. **Co dokładnie testować** definiujesz **promptem**:

- domyślnie plik **[`pr-agent-qa-prompt.md`](../pr-agent-qa-prompt.md)** w root repozytorium (wersjonowany razem z kodem), albo
- zmienna repozytorium **`PR_AGENT_QA_PROMPT`** (treść trafia do env `PR_AGENT_PROMPT` i **nadpisuje** plik), albo
- przy **`workflow_dispatch`**: pole **prompt_file** (ścieżka do innego pliku markdown z promptem).

Krok **`act`** wykonuje instrukcje z prompta (+ kontekst PR: tytuł, opis, pliki, diff) używając **drzewa dostępności (a11y) / DOM** jako źródła prawdy. W tle skrypt podpina się przez Stagehandowy CDP-bridge do zdarzenia `console` i zbiera `console.error` / `console.warn` (blok **Console capture**). **Niezłapane wyjątki JS, failed requesty i odpowiedzi HTTP ≥ 400 nie są łapane** — Stagehand v3 nie wystawia ich na swoim `Page` w publicznym API; jeśli aplikacja sama loguje takie błędy przez `console.error` (np. w gałęzi `catch`), trafiają do capture'a normalną drogą. Krok werdyktu robi **dwa screenshoty** gotowej strony (viewport + full-page), uruchamia w przeglądarce **heurystykę kontrastu** tekst/kolor tła (tekst w DOM, nie tylko piksele) i wynik zapisuje w **`pr-agent-contrast.json`**, a do prompta dokleja tabelę **DOM text contrast (machine check)**. Wysyła to wszystko z promptem QA, a11y snapshotem i diagnostyką do modelu wizyjnego — zwraca strukturalny werdykt **`qaPassed`**. Dzięki temu łatwiej złapać m.in. **niewidzialny** tekst (kolor tła, często z `aria-hidden` — a11y i screenshot mogą nic nie zdradzić) oraz inne regresje wizualne. Screenshoty, `pr-agent-diagnostics.txt` i (gdy włączone) `pr-agent-contrast.json` trafiają do artefaktu **`pr-agent-logs`**.

Jeśli model ustawi `qaPassed: false` (albo wystąpi błąd), job **fail** → możliwa **blokada merge** + **komentarz na PR** (plik `pr-agent-pr-comment.md` z krótkim raportem po angielsku: *Summary*, *Steps to reproduce*, *Expected / Actual result*; bez wklejania całego prompta ani diffa).

**Uwaga:** w werdykcie wciąż decyduje głównie model LLM wg prompta; heurystyka kontrastu tylko **dokłada twardy sygnał w promptcie** (a opcjonalnie twardy fail — patrz `PR_AGENT_CONTRAST_STRICT` poniżej). Wyłącz krok wizyjny (np. model bez vision): **`PR_AGENT_VISION=0`** — werdykt wtedy użyje `Stagehand extract()` (tekst-only) **oraz** tej samej tabeli kontrastu, o ile włączysz ją w env.

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
| `PR_AGENT_RUNS` | (Opcjonalnie) Actions **Variables** lub env lokalny | Ile niezależnych wywołań LLM‑werdyktu na to samo evidence (screenshoty + a11y + diagnostyka przygotowywane raz). Domyślnie **`2`** — agregacja **konserwatywna**: jeśli którykolwiek run zwróci `qaPassed=false`, job fail. Bugi z runów są scalane i dedupowane po `title` (funkcjonalne) / `anchorText` (wizualne). Ustaw `1` lokalnie, żeby szybciej iterować nad promptem. Clamp: 1–5. |
| `PR_AGENT_CONTRAST_SCAN` | (Opcjonalnie) | `0` wyłącza w przeglądarce przechwyt tabeli kontrastu. Domyślnie włączone. |
| `PR_AGENT_CONTRAST_STRICT` | (Opcjonalnie) | Ustaw **`1`**, jeśli przy tekście/ tle o współczynniku poniżej progu (domyślnie ~1.08) build ma **polec zawsze**, nawet gdy model zwróci `qaPassed`. Domyślnie `0` — tylko prompt + tabela, bez wymuszenia. Progi: `PR_AGENT_CONTRAST_STRICT_MAX_RATIO`, `PR_AGENT_CONTRAST_LIST_MAX_RATIO`, `PR_AGENT_CONTRAST_MAX_ROWS`. |
| `PR_AGENT_CONTRAST_LOG` | (Opcjonalnie) | Nazwa pliku z JSON wyników (domyślnie `pr-agent-contrast.json`); trafia do artefaktu. |

**PR z forka** zwykle **nie** dostaje sekretów — MVP zakłada PR-y **z tego samego repozytorium**.

### Opcjonalne logowanie (obszar zmiany za ekranem logowania)

Jeśli obszar zmiany z PR jest dostępny **dopiero po zalogowaniu**, ustaw dwa sekrety — workflow przekaże je do agenta, a ten wypełni formularz logowania **przed** pętlą LLM przez Stagehand/CDP. **Hasło nie trafia do prompta ani do logów**: fill idzie po `page.locator(...).fill(password)` z poziomu Chromium. Do prompta agent dokleja tylko krótki blok „Session context” z informacją, że użytkownik jest zalogowany — dzięki temu LLM nie próbuje się sam logować/wylogowywać.

Autodetect na stronie startowej (działa bez żadnej dodatkowej konfiguracji):

1. Jeśli na `BASE_URL/` widoczne jest **pole hasła** (`input[type=password]`, `[data-testid=login-password]`, itp.) — agent od razu wypełnia i klika submit.
2. Jeśli formularza nie ma, ale jest widoczny **przycisk/link logowania** (a/button/[role=button]/[role=link], którego tekst/aria/href pasuje do `sign in` / `log in` / `login` / `signin` / `zaloguj` / `logowanie`, z wykluczeniem `sign up` / `register` / `zarejestruj` / `create account`) — agent klika go, czeka na widoczny formularz i wtedy wypełnia.
3. Jeśli ani formularza, ani wejścia nie ma — logowanie jest **pomijane** (warning w logu). Domyślnie bramka idzie dalej; `PR_AGENT_LOGIN_STRICT=1` zamienia ten przypadek w twardy fail. Dzięki temu PR dotykające publicznej części aplikacji nie wymagają żadnej ręcznej akcji — agent po prostu nie loguje się, jeśli nie musi.

Najprostsza konfiguracja (wystarczy dla aplikacji z typowym `input[type=email]` / `input[type=password]` / `button[type=submit]`):

| Nazwa | Gdzie | Opis |
| ----- | ----- | ----- |
| `PR_AGENT_LOGIN_USER` | **Secret** | Login/email testowego użytkownika (rekomendacja: konto dedykowane dla QA). |
| `PR_AGENT_LOGIN_PASSWORD` | **Secret** | Hasło tego użytkownika. |

Opcjonalne uszczegółowienia (Variables, niesekretne — selektory/URL bezpiecznie trzymać jawnie):

| Nazwa | Gdzie | Opis |
| ----- | ----- | ----- |
| `PR_AGENT_LOGIN_URL` | Variable | URL (absolutny) lub ścieżka względem `BASE_URL` do strony logowania (np. `/login`). Gdy brak — agent najpierw szuka formularza na stronie startowej, a jeśli go nie widzi, **próbuje kliknąć link/przycisk „Sign in” / „Log in” / „Zaloguj” / „Logowanie”** (po tekście, `aria-label` lub `href`; pomijając „Sign up”/„Register”/„Zarejestruj”). |
| `PR_AGENT_LOGIN_USER_SELECTOR` | Variable | Nadpisanie selektora pola loginu. Domyślnie próbowane są m.in. `[data-testid=login-email]`, `input[type=email]`, `input[name=email]`, `input[name=username]`. |
| `PR_AGENT_LOGIN_PASSWORD_SELECTOR` | Variable | Nadpisanie selektora pola hasła. Domyślnie m.in. `[data-testid=login-password]`, `input[type=password]`. |
| `PR_AGENT_LOGIN_SUBMIT_SELECTOR` | Variable | Nadpisanie selektora przycisku submit. Domyślnie `button[type=submit]`, `[data-testid=login-submit]`. Jeśli nic nie pasuje — wciskany jest **Enter**. |
| `PR_AGENT_LOGIN_SUCCESS_SELECTOR` | Variable | CSS, który ma być widoczny po zalogowaniu (np. `[data-testid=user-menu]`). Gdy ustawiony — twardo sprawdzany. |
| `PR_AGENT_LOGIN_SUCCESS_URL_INCLUDES` | Variable | Fragment URL, który ma pojawić się po zalogowaniu (np. `/app`). |
| `PR_AGENT_LOGIN_STRICT` | Variable | `1` — jeśli logowanie się nie uda, job od razu **fail**. Domyślnie `0` (ostrzeżenie + kontynuacja; bramka może i tak failować później, bo agent nie dotrze do treści). |
| `PR_AGENT_LOGIN_TIMEOUT_MS` | Variable | Maks. czekanie na formularz i na sukces (domyślnie `8000`). |

Uwagi:

- **2FA / captcha** nie są wspierane — potrzebujesz konta bez drugiego składnika (typowo osobny technical user w środowisku testowym).
- Po **udanym** logowaniu agent wraca do `BASE_URL/`, więc reszta flow startuje z głównego ekranu.
- **Nie** wpisuj danych logowania w `PR_AGENT_QA_PROMPT` ani w plik prompta — prompt idzie do OpenRoutera i do `pr-agent.log`. Credentiale trzymaj **wyłącznie** w Secrets.
- Screenshot/artefakt: zrzuty (`pr-agent-screenshot-*.png`) powstają **po** zalogowaniu, więc mogą zawierać dane użytkownika. Używaj konta testowego bez wrażliwych danych.

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

## Uwagi

- Node na runnerze: **20.x** (ustawione w workflow; Stagehand wymaga współczesnego Node — trzymaj się wersji z joba, unikaj eksperymentalnych majorów na CI).
- Logi przy błędzie: artifact **`pr-agent-logs`** (`pr-agent.log`, `pr-agent-failure.txt`, opcjonalnie `pr-agent-pr-comment.md` — ta sama treść co komentarz na PR, plus screenshoty `pr-agent-screenshot-viewport.png` / `pr-agent-screenshot-fullpage.png` i `pr-agent-diagnostics.txt` z `console.error` / `console.warn` zebranymi w trakcie runa). Przy `qaPassed: false` dla każdego wpisu w `bugs[]`, który ma niepuste `anchorText` (typowo `kind: "visual"` — obowiązkowo; opcjonalnie też funkcjonalny, jeśli model poda cytat z UI), pojawia się też `pr-agent-bug-<n>.png` — przycięty wycinek viewportu wokół elementu dopasowanego do anchor-textu. Komentarz PR wymienia te pliki po nazwie i w stopce **wprost** odsyła do artefaktu `pr-agent-logs` (PNG-y nie są w treści komentarza); inline obrazków w komentarzu **nie ma** (żeby nie commitować obrazków do repo).
