# Instrukcja QA dla agenta przeglądarkowego (PR)

Jesteś na **jednej stronie** serwowanej pod `BASE_URL` (nie otwieraj innych domen ani nowych kart).

Wykonaj przeglądarkowy przegląd zgodnie z poniższym:

1. Zlokalizuj przycisk, którego etykieta odnosi się do dodania tekstu „Hello world” poniżej (pod przyciskiem).
2. Jeśli tekstu „Hello world” w oczekiwanym miejscu jeszcze nie ma, kliknij ten przycisk **raz** jak użytkownik.
3. Potwierdź wizualnie, że w obszarze wyniku (np. pod przyciskiem) widać tekst zawierający **Hello world**.
4. Jeśli przycisku nie ma, jest nieaktywny w sposób błędny, albo po kliknięciu nie pojawia się oczekiwany tekst — uznaj test za **niezaliczony**.

Na końcu oceń **czy powyższe kryteria są spełnione** (tak / nie) i wypisz zwięźle, co sprawdziłeś.
