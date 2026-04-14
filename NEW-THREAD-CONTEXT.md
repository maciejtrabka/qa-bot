# Kontekst projektu (wklejka do nowego wątku)

Skopiuj poniżej od „---” do końca do nowego czatu z agentem, żeby od razu mieć pełny obraz.

---

## Cel

MVP **inteligentnej bramki / asysty QA przy Pull Requestach na GitHubie**: przy PR uruchamiany jest workflow, który:

1. Bierze **kontekst zmian** (diff + opis PR — docelowo).
2. Otwiera **preview strony** (np. **Vercel** — publiczny URL z deployu PR).
3. **Testuje UI** w sposób zbliżony do manualnego: **Playwright** (headless na runnerze GitHub Actions).
4. Docelowo **LLM** przez **OpenRouter** pomaga w **planie testów / raporcie** i **priorytetyzacji** znalezionych problemów — na start **sugestia w komentarzu na PR**, **nie** twarda blokada merge (to później, jeśli w ogóle). Na początek **darmowe modele** (plan Free), potem **pay-as-you-go** z doładowanymi kredytami.

## Stack (zamiar)

| Warstwa                | Narzędzie                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger + orchestracja | **GitHub Actions**                                                                                                                                                            |
| Aplikacja pod testem   | **Strona na Vercelu** (preview URL per PR)                                                                                                                                    |
| Automatyzacja UI       | **Playwright** na `ubuntu-latest` (to samo miejsce co job — nie „przeglądarka w LLM”)                                                                                         |
| Model (później)        | **OpenRouter:** najpierw **darmowe modele** (plan [Free](https://openrouter.ai/pricing) — m.in. limit ~50 req/dzień), potem **pay-as-you-go** (kredyty, wyższe limity, wybór płatnych modeli np. Claude) |
| „Zasady testów”        | Docelowo **skill / plik zasad** (np. inspirowany checklistą web QA); MVP: wąski zakres (1 prosta strona, kilka oczywistych bugów do wykrycia)                                 |

## Kolejność implementacji (świadomie bez kosztu LLM na początku)

1. **Najpierw bez API:** Actions + Playwright → `goto(previewUrl)`, screenshot / prosta asercja → **artifact** lub komentarz na PR. Zweryfikować **URL preview**, runner, sekrety (na ten etap bez `OPENROUTER_API_KEY`).
2. **Potem** podłączyć **jedno** wywołanie LLM (plan lub podsumowanie) przez **OpenRouter Free** + tani darmowy model (ok. **50 requestów/dzień**). Gdy MVP działa — **pay-as-you-go** (jeden klucz API, kredyty, wybór lepszego modelu).
3. Rozszerzenia: więcej kroków, agent z **tool use** nad Playwrightem, raport z severity — po stabilnym pipeline.

## Ograniczenia / ryzyka

- **Forki PR + sekrety** — standardowo ostrożnie z sekretami w workflow z niezaufanego kodu.
- **Auth na preview** — jeśli strona nie jest publiczna, trzeba osobnej strategii (token, Basic Auth, wyłącznie wewnętrzny runner — poza MVP publicznej strony).
- **Koszt i limity:** głównie **tokeny LLM** (OpenRouter: najpierw free tier modeli, potem kredyty PAYG); przy bardzo małym MVP **Actions + Vercel Hobby** zwykle mieszczą się w free tier.

## Repo

Lokalny folder projektu: **`qa-bot`** — repo: **https://github.com/maciejtrabka/qa-bot** (strona statyczna + ten plik kontekstu; docelowo workflow Playwright / LLM).

---

_Plik wygenerowany jako opis do wklejenia w nowy wątek; edytuj go wraz z postępem projektu._
