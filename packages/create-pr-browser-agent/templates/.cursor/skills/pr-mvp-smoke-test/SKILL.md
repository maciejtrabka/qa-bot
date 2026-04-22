---
name: pr-mvp-smoke-test
description: Prepares a deliberate PR to exercise the PR browser agent (e.g. pr_browser_agent) on any frontend repo. Syncs the integration branch, picks one UI region on the target app, adds a visible benign tweak plus TWO hidden bugs in that same region — one visual (screenshot-only, e.g. invisible text) and one functional (broken handler/fetch/logic). Opens a PR whose title/body describe only the benign change. Works with React/Vite or other stacks once paths and workflow names are adapted per project.
---

# Smoke test: PR → preview → agent QA (uniwersalny)

**Cel:** jeden PR, który **wygląda** jak mała zmiana (np. styl), ale zawiera **dwa proste bugi w tej samej strefie UI**:

1. **Bug wizualny** — widoczny dopiero na screenshocie (DOM/a11y często go nie „czyta” jak człowiek). Przykłady: tekst w kolorze tła, `visibility: hidden` / `opacity: 0` na kontrolce, `transform` wyrzucający element poza kadr, nakładka zasłaniająca treść.
2. **Bug funkcjonalny** — pęknięty handler, `fetch`, zła ścieżka w JSON, martwy routing formularza itd. (zależnie od stacku).

To pozwala zweryfikować agenta QA (Stagehand `act()` + werdykt z vision), **o ile** w repo jest podpięty workflow typu PR browser agent i ten sam mechanizm kontekstu/werdyktu co w [dokumentacji create-pr-browser-agent](https://github.com/maciejtrabka/qa-bot) / lokalnym `AGENTS.md`.

---

## Wymagania wstępne (dopasuj do projektu)

Przed pierwszą edycją kodu **ustal w tym repozytorium**:

| Co ustalić | Przykłady / gdzie szukać |
|------------|---------------------------|
| **Branch integracji** | Zwykle `main`; czasem `master` albo domyślny branch z ustawień GitHub → *Settings → General*. PR z tego skilla idzie **w ten branch**. |
| **Frontend — wejście i style** | Vite+React: `src/main.tsx`, `src/App.tsx`, `src/index.css`. Next: `app/`, `src/app/`. Vue: `src/App.vue`. Znajdź **realne** pliki z layoutem strony docelowej. |
| **Nazwa checka / workflow** | W `.github/workflows/` plik np. `pr-browser-agent.yml`; w Branch protection nazwa joba np. `pr_browser_agent`. **Nie zakładaj** — sprawdź plik YAML. |
| **Build i podgląd w CI** | Workflow powinien robić `npm run build` (lub `pnpm`/`yarn`) i serwować `dist` / output — dopasuj ścieżki tylko jeśli zmieniasz coś, co wpływa na build. |

Jeśli projekt **nie ma** jeszcze workflow PR browser agent — najpierw `npm create pr-browser-agent@latest` (lub ręczna kopia z [qa-bot](https://github.com/maciejtrabka/qa-bot)) i dopiero potem ten smoke.

---

## Zasady (niezależne od frameworka)

1. **Baza: lokalny branch integracji zsynchronizowany z `origin`** — przed branchowaniem: `git checkout <main-or-default> && git pull origin <main-or-default>`.
2. **Żadnych „testowych” commitów na branchu integracji** — eksperyment wyłącznie na **nowym branchu** od świeżej bazy.
3. **Tytuł i body PR** — wyłącznie o **widocznej** zmianie z diffa. **Nie wspominaj** bugów, agenta ani bramki. **Nie dopisuj** sekcji o komponentach / plikach / klasach, których **nie ma** w tym diffie. Każde zdanie musi opisywać rzecz z `git diff`. Jeden temat, jedna strefa UI, 2–4 zdania.
4. **Trójka w jednej strefie:** **kosmetyka** + **bug wizualny** + **bug funkcjonalny** — wszystko w **tym samym** fragmencie UI (ta sama karta, ten sam panel, ta sama strona routa), żeby kontekst PR i agent „okolicy zmiany” miały sens.
5. Po pushu: **PR do brancha integracji** (domyślnie `main`).

---

## Mapa witryny — zbuduj ją w *tym* projekcie

Zamiast stałej tabeli z jednego repo:

1. **Znajdź stronę / widok startowy** albo ten, który najłatwiej opisać w PR (jeden ekran, jedna sekcja).
2. **Rozpisz „strefy”** — logiczne bloki UI (karty, kolumny, zakładki, sekcje `tab === '…'`, route’y). Wystarczy tabela w notatce agenta (nie w repo):

   | Strefa (nazwa robocza) | Plik(i) | Co testować (przyciski, `data-testid`, fetch) |
   |------------------------|---------|-----------------------------------------------|
   | … | … | … |

3. **Wybierz jedną strefę** z sensowną interakcją: przycisk + widoczny skutek albo `fetch` — łatwiej zrobić **funkcjonalny** bug bez rozwalania całej aplikacji.
4. **Sprawdź refaktor:** po zmianie nazw plików ponów punkt 1–2 (skill nie zakłada stałych ścieżek poza konwencją „szukaj w `src/`”).

**Wskazówka:** strefy z **zewnętrznym API** (pogoda, kurs, fakty) są wygodne do buga funkcjonalnego; strefy tylko z copy — bug funkcjonalny może być „martwy link”, zły `navigate`, oczywisty bełkot w tym samym akapicie co kosmetyka.

---

## Losowanie (przed edycją)

1. **Wylosuj strefę** z własnej tabeli mapy (np. „karta A”, „panel ustawień”, „strona /contact”).
2. **Wylosuj widoczną zmianę** tylko tam: CSS (border, tło, radius, margin), albo jedna fraza copy w tym bloku. Możesz dodać klasę BEM/modifier **tylko** pod tę kartę (np. `feature-card--accent`).
3. **Bug wizualny** — **tylko CSS** (lub równoważne: np. warstwa w template), bez usuwania treści z DOM; efekt „widać na screenshocie, nie z treści DOM”. Przykłady uniwersalne:
   - kolor tekstu = kolor tła na elemencie wyniku;
   - `visibility: hidden` / `opacity: 0` na CTA (w a11y nadal może być);
   - `transform: translateX(-9999px)` na jednym przycisku;
   - pseudo-element / overlay z tłem jak karta na obszarze wyniku;
   - jasny tekst na jasnym tle.
4. **Bug funkcjonalny** — w **tej samej strefie**, inna „linia” niż wizualny (np. wizualny na `color`, funkcjonalny na `fetch`):

   - **Sieć:** literówka w URL, złe pole JSON, zły header.
   - **Stan UI:** `onClick` no-op, zły setter (np. `setX(n => n)` zamiast `n+1`), zepsuty warunek renderu.
   - **Routing / formularz:** zła ścieżka, submit bez efektu — jeśli to jedyna logika w strefie.
   - **Bez sieci:** popsuty fragment treści / link w tym samym bloku co kosmetyka.

5. **Nie mieszaj:** jeden plik może zawierać oba bugi, ale **dwa niezależne defekty** (np. funkcjonalny nie przez sam `color`).

6. **Notatka poza Gitem:** która strefa + wariant wizualny + funkcjonalny — do ground truth w raporcie.

---

## Kroki (wykonaj po kolei)

### 1. Przeczytaj aktualne pliki strefy

Otwórz **konkretne** pliki z mapy (np. komponent strony + arkusz stylów). Potwierdź strukturę — **nie** ufaj starej tabeli z innego repo.

### 2. Branch od świeżego brancha integracji

```bash
git checkout <BRANCH_INTEGRACJI>
git pull origin <BRANCH_INTEGRACJI>
git checkout -b <nazwa-brancha>
```

Nazwa brancha: pod widoczną zmianę, np. `ui/card-accent`, `style/hero-border`.

### 3. Wprowadź trójkę w jednej strefie

- Najpierw **kosmetyka**.
- Potem **bug wizualny** (preferencyjnie CSS / warstwa prezentacji).
- Potem **bug funkcjonalny** (logika / handler / fetch w tej strefie).

### 4. Commit

Jedna wiadomość opisująca **tylko** kosmetykę — **bez** słów typu `break`, `test`, `intentional`.

### 5. Push + PR

```bash
git add <ścieżki-z-diffa>
git commit -m "<wiadomość>"
git push -u origin HEAD
gh pr create --base <BRANCH_INTEGRACJI> --title "<tytuł>" --body-file body.md
```

**Body PR:** 2–4 zdania wyłącznie o **widocznej** zmianie.

**Walidacja `body.md` (obowiązkowa):**

1. Lista tego, co **jest** w diffie (kosmetyka jawna; bugi — na liście wewnętrznie, nie w PR).
2. Każde zdanie body musi odpowiadać pozycji z kosmetyki. Usuń zdania o innych sekcjach, nieistniejących klasach, efektach spoza diffa.
3. Po pustce — napisz body od zera, neutralnie.
4. Po utworzeniu PR: `gh pr view <n> --json body` vs diff; popraw: `gh pr edit <n> --body-file body.md`.

### 6. Gdy `gh pr create` zwraca błąd GraphQL

```bash
gh api repos/<owner>/<repo>/pulls -X POST \
  -f title='...' \
  -f head='<branch>' \
  -f base='<BRANCH_INTEGRACJI>' \
  -F body=@body.md
```

---

### 7. Po otwarciu PR — agent i werdykt

Workflow musi być **w tym** repo (nazwa pliku sprawdź w `.github/workflows/`). Po pushu:

```bash
gh pr checks <PR_NUMBER>
gh api repos/<owner>/<repo>/issues/<PR_NUMBER>/comments --jq '.[-1].body'
```

Artefakt logów (jeśli workflow go publikuje pod znanym name):

```bash
RUN_ID=$(gh run list --branch <branch> --workflow "<NAZWA_PLIKU_WORKFLOW>.yml" --limit 1 --json databaseId --jq '.[0].databaseId')
gh run download "$RUN_ID" -n pr-agent-logs -D .pr-agent-logs
```

**Nie commituj** artefaktów; `.pr-agent-logs/` trzymaj poza Gitem (`.gitignore`).

### 8. Po raporcie wróć na branch integracji

```bash
git checkout <BRANCH_INTEGRACJI>
git pull --ff-only origin <BRANCH_INTEGRACJI>
git status
```

Brancha PR **nie usuwaj** — zostaw do review. Lokalne śmieci z logów nie idą do commita.

---

## Raport końcowy dla użytkownika (obowiązkowy)

Po zakończeniu checka odeślij **po polsku**, 3 sekcje:

### 1. Jaką zmianę wprowadziłem
- PR #…, tytuł, link  
- Strefa UI w **tym** projekcie (np. „karta X na stronie głównej”)  
- Jedna linia kosmetyki  

### 2. Ground truth — bugi
- **Wizualny:** selektor / reguła + co widać na screenshocie  
- **Funkcjonalny:** plik + miejsce w kodzie (komponent/handler) + objaw  

*(Zamiast „React” użyj faktycznego stacku: Vue/Svelte/vanilla.)*

### 3. Co znalazł agent (`pr_browser_agent` lub nazwa z YAML)
- `qaPassed` + status joba  
- Krótki Summary z komentarza  
- Mapowanie: funkcjonalny złapany / nie; wizualny złapany / nie / tylko Notes — ze **cytatem** z komentarza  
- Linki do joba i komentarza  

Jeśli czegoś nie ma w komentarzu — **nie zgaduj**; napisz wprost „nie widać w raporcie”.

---

## Checklist

- [ ] Branch integracji zsynchronizowany przed `checkout -b`
- [ ] Mapa stref zrobiona **w bieżącym** repo (nie skopiowana z innego)
- [ ] Kosmetyka + bug wizualny + funkcjonalny w **jednej** strefie; diff to pokazuje
- [ ] Bug wizualny przez prezentację (CSS / overlay), nie przez kasowanie treści z DOM
- [ ] Bugi rozłączne (dwa niezależne problemy)
- [ ] PR nie zdradza bugów; każde zdanie tytułu/body = rzecz z diffa
- [ ] `gh pr view … body` zgodne z diffem
- [ ] Poczekano na workflow; zebrano komentarz / artefakty
- [ ] Raport 3-sekcyjny + powrót na branch integracji

---

## Kontekst techniczny (ogólnie)

Typowy PR browser agent: build PR → podgląd statyczny → kontekst `pr-context/` (tytuł, pliki, diff) → Stagehand + LLM → werdykt `qaPassed` wg prompta repo (np. `pr-agent-qa-prompt.md`). Zakres testu to **okolica zmiany**, nie cała witryna — stąd **jedna gęsta strefa** w diffie.

Szczegóły **w danym** projekcie: lokalne `AGENTS.md` / `docs/PR-AGENT-QA.md` (jeśli istnieją).

---

## Załącznik: przykład mapy dla repozytorium **qa-bot** (demo)

Tylko gdy pracujesz **w tym** repo — wtedy typowe pliki to `src/App.tsx`, `src/index.css`. Strefy startowe:

| Strefa | Plik | Testid / symbole |
|--------|------|------------------|
| Demo pogoda | `src/App.tsx` | `cta-primary`, `weather-output`, `OPEN_METEO_KRK` |
| Demo kot | `src/App.tsx` | `cat-fact-button`, `cat-fact-output`, `fetchCatFact` |
| Licznik | `src/App.tsx` | `counter-plus`, `slot-counter-value` |
| Kurs FX | `src/App.tsx` | `fx-button`, `fx-output`, `FRANKFURTER_EUR_PLN` |
| Zakładki treści | `src/App.tsx` | `tab === "onas"` / `"zajecia"` / … |

Najprostszy smoke: **jedna z czterech kart demo** na starcie (fetch + przycisk w jednym diffie). W innym projekcie **nie kopiuj** tej tabeli — zbuduj własną mapę jak wyżej.
