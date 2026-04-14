# Instrukcje dla agentów (Cursor / AI)

## Obowiązek: `NEW-THREAD-CONTEXT.md`

Plik **`NEW-THREAD-CONTEXT.md`** (w katalogu głównym repo, **lokalny** — wpisany w `.gitignore`, nie trafia na GitHub) jest **źródłem prawdy o stanie projektu** do wklejania w nowych wątkach czatu.

**Po każdej istotnej zmianie** (nowy workflow, testy Playwright, Vercel, sekrety, LLM, zmiana zakresu MVP) **zaktualizuj ten plik** tak, żeby:

1. Sekcje **Zrobione** i **Do zrobienia** odzwierciedlały aktualny postęp (datę w nagłówku stanu zaktualizuj przy większych krokach).
2. Sekcja **Repo / linki** miała poprawne URL-e i krótki opis tego, co jest w `main`.
3. Opis **Cel / Stack / Kolejność** pozostawał zgodny z rzeczywistością — jeśli coś z planu się zmieniło, popraw to w tekście, nie tylko w listach.

Nie usuwaj historii sensownie z sekcji „Zrobione” bez powodu; możesz skracać bardzo stare punkty do jednej linii „… (wcześniej: …)”, jeśli plik rośnie za bardzo.

## Struktura oczekiwana w `NEW-THREAD-CONTEXT.md`

Poza blokiem od `---` w dół muszą być czytelne sekcje:

| Sekcja | Rola |
|--------|------|
| **Postęp (stan)** | Krótka data lub „ostatnia aktualizacja”; potem **Zrobione** i **Do zrobienia** |
| **Cel / Stack / …** | Bez zmian w zamysle — aktualizuj treść, gdy produkt się zmienia |
| **Repo** | Link do GitHuba, co jest commitowane, przypomnienie że kontekst jest lokalny |

Użytkownik **wkleja zawartość** `NEW-THREAD-CONTEXT.md` (od `---` do końca lub cały plik) do nowego wątku — **stamtąd ma być widać, na czym skończono i co zostało.**

## To repo (skrót)

- **Publicznie na GitHubie:** strona statyczna, workflow, testy, konfiguracja — wszystko potrzebne do CI.
- **Tylko lokalnie:** `NEW-THREAD-CONTEXT.md` (oraz ewentualnie `.env`; patrz `.gitignore`).

## `AGENTS.md` w repozytorium

Ten plik **jest commitowany** — służy jako stała instrukcja dla agentów pracujących w tym repo. Nie zastępuje `NEW-THREAD-CONTEXT.md`; uzupełnia go o zasady utrzymania kontekstu.
