import { useCallback, useState } from "react";

type TabId = "start" | "onas" | "zajecia" | "grafik" | "studio";

const TABS: { id: TabId; label: string }[] = [
  { id: "start", label: "Start" },
  { id: "onas", label: "O nas" },
  { id: "zajecia", label: "Zajęcia" },
  { id: "grafik", label: "Grafik" },
  { id: "studio", label: "Studio" },
];

const CLASSES = [
  {
    title: "Hatha · poranek",
    time: "07:30–08:45",
    level: "wszystkie poziomy",
    note: "Ukierunkowanie oddechu, stabilne pózowanie, krótkie wyciszenie na koniec.",
  },
  {
    title: "Vinyasa flow",
    time: "18:00–19:15",
    level: "średnio zaawansowani",
    note: "Płynne przejścia, rozgrzewka i balans — bez presji tempa.",
  },
  {
    title: "Yin & nidra",
    time: "20:00–21:15",
    level: "oddech i regeneracja",
    note: "Długie pózowanie, wsparcie rekwizytami, końcowa joga świadomego odpoczynku.",
  },
];

const WEEK: { day: string; slots: string[] }[] = [
  { day: "Pon.", slots: ["07:30 Hatha", "18:00 Vinyasa", "20:00 Yin"] },
  { day: "Wt.", slots: ["18:30 Vinyasa"] },
  { day: "Śr.", slots: ["07:30 Hatha", "19:00 Hatha"] },
  { day: "Czw.", slots: ["18:00 Vinyasa", "20:00 Yin"] },
  { day: "Pt.", slots: ["07:30 Hatha", "17:30 Vinyasa"] },
  { day: "Sob.", slots: ["10:00 warsztaty (sezonowo)"] },
  { day: "Ndz.", slots: ["—"] },
];

/** Publiczne API — bez kluczy; przydatne do regresji w PR (URL, parsowanie JSON, stany UI). */
const OPEN_METEO_KRK =
  "https://api.open-meteo.c0m/v1/forecast?latitude=50.0614&longitude=19.9366&current=temperature_2m&timezone=auto";

/** Kanoniczny host API (stary frankfurter.app robi 301 — fetch z przeglądarki bywa zawodny). */
const FRANKFURTER_EUR_PLN =
  "https://api.frankfurter.dev/v1/latest?from=EUR&to=PLN";

export default function App() {
  const [tab, setTab] = useState<TabId>("start");

  const [weather, setWeather] = useState<{
    c: number | null;
    err: string | null;
    loading: boolean;
  }>({ c: null, err: null, loading: false });

  const [catFact, setCatFact] = useState<{
    text: string | null;
    err: string | null;
    loading: boolean;
  }>({ text: null, err: null, loading: false });

  const [slotsLeft, setSlotsLeft] = useState(5);

  const [fx, setFx] = useState<{
    plnPerEur: number | null;
    err: string | null;
    loading: boolean;
  }>({ plnPerEur: null, err: null, loading: false });

  const fetchWeather = useCallback(async () => {
    setWeather((w) => ({ ...w, loading: true, err: null }));
    try {
      const r = await fetch(OPEN_METEO_KRK);
      if (!r.ok) throw new Error("http");
      const j = (await r.json()) as {
        current?: { temperature_2m?: number };
      };
      const t = j.current?.temperature_2m;
      if (typeof t !== "number") throw new Error("shape");
      setWeather({ c: Math.round(t * 10) / 10, err: null, loading: false });
    } catch {
      setWeather({
        c: null,
        err: "Nie udało się pobrać pogody.",
        loading: false,
      });
    }
  }, []);

  const fetchCatFact = useCallback(async () => {
    setCatFact((c) => ({ ...c, loading: true, err: null }));
    try {
      const r = await fetch("https://catfact.ninja/fact");
      if (!r.ok) throw new Error("http");
      const j = (await r.json()) as { fact?: string };
      if (typeof j.fact !== "string") throw new Error("shape");
      setCatFact({ text: j.fact, err: null, loading: false });
    } catch {
      setCatFact({
        text: null,
        err: "Nie udało się pobrać faktu.",
        loading: false,
      });
    }
  }, []);

  const fetchFx = useCallback(async () => {
    setFx((x) => ({ ...x, loading: true, err: null }));
    try {
      const r = await fetch(FRANKFURTER_EUR_PLN);
      if (!r.ok) throw new Error("http");
      const j = (await r.json()) as { rates?: { PLN?: number } };
      const rate = j.rates?.PLN;
      if (typeof rate !== "number") throw new Error("shape");
      setFx({ plnPerEur: rate, err: null, loading: false });
    } catch {
      setFx({
        plnPerEur: null,
        err: "Nie udało się pobrać kursu.",
        loading: false,
      });
    }
  }, []);

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">
        Przejdź do treści
      </a>

      <header className="top">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ◯
          </span>
          <div>
            <p className="eyebrow">studio jogi · Kraków, Kazimierz</p>
            <h1 className="brand-title" data-testid="hero-title">
              Āsana
            </h1>
          </div>
        </div>

        <nav className="tabs" aria-label="Zakładki witryny">
          <ul className="tab-list" role="tablist">
            {TABS.map((t) => (
              <li key={t.id} role="none">
                <button
                  type="button"
                  role="tab"
                  id={`tab-${t.id}`}
                  aria-selected={tab === t.id}
                  aria-controls={`panel-${t.id}`}
                  className={`tab ${tab === t.id ? "tab-active" : ""}`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <main id="main-content" className="main" data-testid="page-root">
        {tab === "start" && (
          <section
            className="panel"
            id="panel-start"
            role="tabpanel"
            aria-labelledby="tab-start"
          >
            <div className="hero-block">
              <h2 className="panel-heading">Miejsce bez pośpiechu</h2>
              <p className="lede">
                Małe grupy, naturalne światło i instruktorzy, którzy słuchają ciała —
                nie tylko „dopinają” pozycję. Zostawiamy przestrzeń na oddech i
                uważność, nie na porównywanie się z sąsiadem na macie.
              </p>
            </div>

            <div className="highlights">
              <article className="highlight">
                <h3>Grupy do 12 osób</h3>
                <p>Żeby można było zwrócić uwagę na detal — i na Ciebie.</p>
              </article>
              <article className="highlight">
                <h3>Maty i kocyki na miejscu</h3>
                <p>Wystarczy wygodny strój; my dbamy o resztę sprzętu.</p>
              </article>
              <article className="highlight">
                <h3>Bez presji „idealnej” praktyki</h3>
                <p>Warianty póz, propsy, jasne wskazówki — bez pokazów akrobatyki.</p>
              </article>
            </div>

            <section
              className="demo-interactions"
              aria-labelledby="demo-heading"
            >
              <h2 id="demo-heading" data-testid="section-status">
                Demo interakcji
              </h2>
              <p className="muted demo-lede">
                Poniżej: publiczne API (bez kluczy i bez Twojej bazy) oraz prosty
                licznik w przeglądarce — wygodne do celowych regresji w PR
                (URL, JSON, stany).
              </p>

              <div className="demo-grid">
                <article className="interactive-card demo-card--weather">
                  <h3 className="interactive-title">Pogoda · Kraków</h3>
                  <p className="interactive-api">Open-Meteo</p>
                  <button
                    type="button"
                    className="btn"
                    data-testid="cta-primary"
                    onClick={fetchWeather}
                    disabled={weather.loading}
                  >
                    {weather.loading ? "Ładowanie…" : "Pobierz temperaturę"}
                  </button>
                  <div
                    className="interactive-output"
                    data-testid="weather-output"
                    aria-live="polite"
                  >
                    {weather.err && (
                      <p className="interactive-msg interactive-msg-error">
                        {weather.err}
                      </p>
                    )}
                    {!weather.err && weather.c !== null && (
                      <p className="interactive-msg">
                        Teraz ok. <strong>{weather.c}°C</strong> (aktualna
                        temperatura powietrza).
                      </p>
                    )}
                    {!weather.err && weather.c === null && !weather.loading && (
                      <p className="interactive-placeholder">
                        Kliknij przycisk, żeby zobaczyć odczyt.
                      </p>
                    )}
                  </div>
                </article>

                <article className="interactive-card">
                  <h3 className="interactive-title">Losowy fakt</h3>
                  <p className="interactive-api">catfact.ninja</p>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    data-testid="cat-fact-button"
                    onClick={fetchCatFact}
                    disabled={catFact.loading}
                  >
                    {catFact.loading ? "Ładowanie…" : "Nowy fakt o kotach"}
                  </button>
                  <div
                    className="interactive-output"
                    data-testid="cat-fact-output"
                    aria-live="polite"
                  >
                    {catFact.err && (
                      <p className="interactive-msg interactive-msg-error">
                        {catFact.err}
                      </p>
                    )}
                    {catFact.text && (
                      <p className="interactive-msg">{catFact.text}</p>
                    )}
                    {!catFact.err && !catFact.text && !catFact.loading && (
                      <p className="interactive-placeholder">
                        Fakt pojawi się tutaj.
                      </p>
                    )}
                  </div>
                </article>

                <article className="interactive-card">
                  <h3 className="interactive-title">Wolne miejsca (symulacja)</h3>
                  <p className="interactive-api">tylko przeglądarka</p>
                  <div className="counter-row">
                    <button
                      type="button"
                      className="btn-counter"
                      data-testid="counter-minus"
                      onClick={() =>
                        setSlotsLeft((n) => Math.max(0, n - 1))
                      }
                      aria-label="Zmniejsz licznik"
                    >
                      −
                    </button>
                    <span
                      className="counter-value"
                      data-testid="slot-counter-value"
                    >
                      {slotsLeft}
                    </span>
                    <button
                      type="button"
                      className="btn-counter"
                      data-testid="counter-plus"
                      onClick={() =>
                        setSlotsLeft((n) => Math.min(12, n + 1))
                      }
                      aria-label="Zwiększ licznik"
                    >
                      +
                    </button>
                  </div>
                  <p className="interactive-hint">
                    Liczba wolnych miejsc na najbliższe zajęcia (demo, max 12).
                  </p>
                </article>

                <article className="interactive-card">
                  <h3 className="interactive-title">Kurs EUR → PLN</h3>
                  <p className="interactive-api">Frankfurter · api.frankfurter.dev</p>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    data-testid="fx-button"
                    onClick={fetchFx}
                    disabled={fx.loading}
                  >
                    {fx.loading ? "Ładowanie…" : "Pobierz kurs"}
                  </button>
                  <div
                    className="interactive-output"
                    data-testid="fx-output"
                    aria-live="polite"
                  >
                    {fx.err && (
                      <p className="interactive-msg interactive-msg-error">
                        {fx.err}
                      </p>
                    )}
                    {fx.plnPerEur !== null && (
                      <p className="interactive-msg">
                        1 EUR ≈ <strong>{fx.plnPerEur.toFixed(4)}</strong> PLN
                        (ECB).
                      </p>
                    )}
                    {!fx.err && fx.plnPerEur === null && !fx.loading && (
                      <p className="interactive-placeholder">
                        Kurs pojawi się po kliknięciu.
                      </p>
                    )}
                  </div>
                </article>
              </div>
            </section>
          </section>
        )}

        {tab === "onas" && (
          <section
            className="panel"
            id="panel-onas"
            role="tabpanel"
            aria-labelledby="tab-onas"
          >
            <h2 className="panel-heading">Kim jesteśmy</h2>
            <div className="prose">
              <p>
                <strong>Āsana</strong> to studio założone przez trzech nauczycieli, którzy
                poznali się na szkoleniach w Himalajach i postanowili przywieźć do
                miasta coś prostego: jogę bez marketingowego pośpiechu.
              </p>
              <p>
                Wierzymy, że regularność ma sens tylko wtedy, gdy praktyka jest
                bezpieczna i przyjazna — stąd małe grupy, czas na pytania po zajęciach
                i przestrzeń na ciszę, kiedy jej potrzebujesz.
              </p>
              <blockquote className="pullquote">
                „Nie chodzi o to, jak głęboko schodzisz w pózę — tylko czy potrafisz
                wyjść z niej bez szarpania oddechem.”
                <footer>— Ania, założycielka</footer>
              </blockquote>
            </div>
          </section>
        )}

        {tab === "zajecia" && (
          <section
            className="panel"
            id="panel-zajecia"
            role="tabpanel"
            aria-labelledby="tab-zajecia"
          >
            <h2 className="panel-heading">Formaty</h2>
            <ul className="class-grid">
              {CLASSES.map((c) => (
                <li key={c.title} className="class-card">
                  <h3>{c.title}</h3>
                  <p className="class-meta">
                    {c.time} · {c.level}
                  </p>
                  <p>{c.note}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {tab === "grafik" && (
          <section
            className="panel"
            id="panel-grafik"
            role="tabpanel"
            aria-labelledby="tab-grafik"
          >
            <h2 className="panel-heading">Tygodniowy rozkład</h2>
            <p className="muted schedule-note">
              Poglądowy grafik — szczegóły i ewentualne zmiany sezonowe ogłaszamy na
              tablicy w holu studia.
            </p>
            <div className="schedule">
              {WEEK.map((row) => (
                <div key={row.day} className="schedule-row">
                  <div className="schedule-day">{row.day}</div>
                  <ul className="schedule-slots">
                    {row.slots.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        )}

        {tab === "studio" && (
          <section
            className="panel"
            id="panel-studio"
            role="tabpanel"
            aria-labelledby="tab-studio"
          >
            <h2 className="panel-heading">Studio</h2>
            <div className="studio-grid">
              <div className="studio-card">
                <h3>Przestrzeń</h3>
                <p>
                  Sala 85 m², drewniana podłoga, naturalne światło od podwórka —
                  latem stawiamy skrzydła drzwi, żeby wpuścić powiew z ogródka sąsiada z
                  bazylią (serio).
                </p>
              </div>
              <div className="studio-card">
                <h3>Dojazd</h3>
                <p>
                  6 min pieszo od tramwaju na Stradomskiej. Parking strzeżony 200 m —
                  podajemy kod na recepcji, jeśli go potrzebujesz.
                </p>
              </div>
              <div className="studio-card">
                <h3>Kontakt (tylko informacja)</h3>
                <p>
                  ul. Józefa 12, 31-056 Kraków
                  <br />
                  Wejście od podwórka, dzwonek „Āsana”.
                </p>
                <p className="contact-lines">
                  <span>tel. 12 345 67 89 (pn–pt 9:00–18:00)</span>
                  <span>witaj@asana-krakow.example</span>
                </p>
                <p className="fine-print">
                  To są dane fikcyjne na potrzeby demonstracji — bez formularzy i
                  wysyłania treści z przeglądarki.
                </p>
              </div>
            </div>
          </section>
        )}
      </main>

      <footer className="foot">
        <p>Āsana © {new Date().getFullYear()} · strona wizytówkowa (demo QA)</p>
      </footer>
    </div>
  );
}
