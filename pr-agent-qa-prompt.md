# Instrukcja QA dla agenta przeglądarkowego (PR)

Jesteś na **jednej aplikacji** serwowanej pod `BASE_URL` (początek: strona główna). **Nie wychodź poza ten sam origin** (inne domeny / nowe karty — zabronione). Jeśli zmiana z PR dotyczy innej ścieżki w tej samej aplikacji, **przejdź wewnętrznymi linkami** lub sensownym nawigowaniem po tym samym hoście, żeby dotrzeć do miejsca objętego zmianą.

## Kontekst zmiany (już dostajesz w promptcie systemowym)

Masz **tytuł i opis PR**, listę **zmienionych plików** oraz **fragment diffa**. Potraktuj je jako źródło prawdy o **intencji i zakresie** — nie ignoruj ich przy planowaniu testów.

## Co zrobić

1. **Zrozum, co PR zmienia** (komponent, tekst, zachowanie, układ, obsługa zdarzeń) na podstawie opisu i diffa.
2. **Na stronie zweryfikuj**, czy po tej zmianie UI i zachowanie nadal są **spójne i sensowne** dla użytkownika: czy to, co diff sugeruje jako cel, faktycznie działa; czy nic istotnego **nie zniknęło**; czy akcje (klik, wpis, itp.) mają **oczekiwany, logiczny skutek** (brak „martwego” przycisku, pustego miejsca zamiast treści, oczywistej regresji treści/stanu).
3. Skup się na **ryzyku regresji** względem intencji PR — nie wymagaj testów funkcji **poza** sensownym związkiem ze zmianą (chyba że widzisz oczywisty krytyczny błąd blokujący użycie strony).
4. **Blokujące (niezaliczony test):** brak kluczowego elementu lub treści, którą zmiana miała zapewnić; działanie sprzeczne z opisem PR; wyraźna regresja (np. zamiast oczekiwanej treści pojawia się bezsensowny / losowy tekst, jeśli diff i opis wskazują na konkretną, poprawną treść lub zachowanie).

Na końcu oceń **czy powyższe kryteria blokujące są spełnione** (tak / nie) i wypisz zwięźle, co sprawdziłeś.
