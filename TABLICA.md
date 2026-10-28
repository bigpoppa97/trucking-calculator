# Tablica floty — etap 1

Tablica zastępuje roboczy grafik w Excelu: po imporcie eksportu z aplikacji sama układa zlecenia
8 ciągników działu na tygodniu, liczy marżę i kilometry, a wszystko, co wymaga decyzji człowieka,
trafia na listę „Do sprawdzenia”. Działa w tym samym programie co kalkulator (ten sam serwer, ta sama
baza, to samo logowanie) — kalkulator jest osobną zakładką.

## Pierwsze uruchomienie (Windows)

1. Zamknij okno „Kalkulator kosztow - serwer” (na pasku zadań).
2. W folderze projektu otwórz `cmd` (pasek adresu Eksploratora → wpisz `cmd` → Enter) i wpisz:
   ```
   git fetch origin
   git checkout feature/tablica-floty
   ```
3. Kliknij dwukrotnie `scripts\aktualizuj.cmd`. Skrypt:
   - pobiera nową wersję, instaluje zależności i buduje interfejs,
   - robi kopię bazy do `data\kopie\` i dodaje tabele tablicy (migracja 0009),
   - pyta, czy wczytać auta z grafiku — odpowiedz **T**, przeciągnij do okna plik grafiku (.xlsm),
     potem świeży eksport z aplikacji (.xlsx), a jako naczepy-plandeki wpisz np. `KN560PP`,
   - uruchamia serwer i otwiera przeglądarkę.
4. Zaloguj się swoim kontem kalkulatora. Notatki i poprawki na tablicy podpisują się imieniem
   z konta; nowe konta dla zespołu zakładasz w zakładce „Użytkownicy”.

Kolejne aktualizacje: zamknij okno serwera i kliknij `scripts\aktualizuj.cmd` (na pytanie o grafik — **N**).

Dane osobowe (kierowcy, telefony, stawki) zostają w lokalnej bazie — nic nie trafia do repozytorium.
Wczytanie grafiku można powtórzyć, nie nadpisuje istniejących wpisów.

## Codzienna praca

1. W aplikacji: zapisany widok AG Grid (wszyscy klienci, data załadunku od 7 dni wstecz + przyszłe) → eksport .xlsx.
2. Tablica → „Do sprawdzenia” → upuść plik. Import 2–3 razy dziennie. Mały plik z kilkoma zleceniami z ostatniej
   chwili (albo eksport z dodatkowym filtrem) też można wgrać: gdy jest w nim najwyżej połowa zleceń, które tablica
   ma w jego dniach, tablica tylko dodaje nowe i aktualizuje zmienione — braków nie oznacza jako „zniknęło”
   (sprawdzi je następny pełny eksport). Stopka tablicy pokazuje ostatni pełny eksport i późniejsze „uzupełnienie”.
3. Przejrzyj listę: literówki naczep i miejsc zatwierdza się raz (tablica zapamiętuje), wysoka marża
   zwykle oznacza brak wpisu przepinki, stawka/km poza zakresem — kwotę w PLN.
4. Przepinka: w uwagach zlecenia klienta w aplikacji `PRZ GORZYCZKI 26.04 WGM4518U>KN1050H 700/400`
   (miejsce, data, auto oddające > auto przejmujące, kwota dla każdego auta). Marża = stawka klienta − suma kwot.
   **Skonto**: gdy koszt w aplikacji to kwota auta z eksportu minus 1,5% (np. 1600 → 1576; albo suma obu kwot, gdy
   oba auta są jednego przewoźnika), to nie błąd — tablica liczy kwotę po skoncie, a panel pokazuje
   „kwota 1 576 € (1 600 € − 1,5% skonta)”. Inna różnica nadal trafia do „Do sprawdzenia”.
5. Prom (płaci dział, więc pomniejsza marżę): w tych samych uwagach `PROM 1180` (kwota w EUR, przecinek
   dziesiętny, np. `PROM 1180,50`; po kwocie można dopisać opis, np. `PROM 1180 Finnlines HEL-TRA`). Kilka wpisów
   się sumuje; wpis bez kwoty trafia do „Do sprawdzenia”. Ręczna poprawka „Koszt dodatkowy” zastępuje prom z uwag,
   dopóki aplikacja nie zmieni wpisu PROM.
6. Zlecenie spedycyjne anulowane w aplikacji (status A) bez wpisu PRZ — auto go nie wiezie: znika z tablicy
   i z wyników, zostaje tylko na liście zleceń zestawu jako „anulowane u przewoźnika”.

7. Godziny: tablica czyta kolumny „Godziny załadunku” i „Godziny rozładunku” z eksportu (muszą być w zapisanym
   widoku). Załadunek = początek okna, rozładunek = koniec okna („do 16:00”). Dwa zlecenia auta tego samego dnia
   stoją w jednym wierszu (dzień dzielony na pół), gdy rozładunek pierwszego jest przed załadunkiem drugiego.
   Faktyczna godzina inna niż w zleceniu: panel zlecenia → „Popraw ręcznie” → Załadunek / Rozładunek,
   np. `07.10 12:00` albo sama godzina `12:00`. Zmieniona data załadunku przenosi zlecenie na ten dzień (także w sumach).
8. Zlecenie wstępne (uzgodnione, zanim klient wyśle zlecenie): „+” pod dniem auta → Rodzaj „Zlecenie wstępne”.
   Numer „W-1”, „W-2”…, przerywana szara ramka. Liczy się w km i sumach (bez którejś z kwot — tylko w km).
   Import zastępuje je zleceniem z aplikacji na tym samym aucie z załadunkiem ±1 dzień (notatki przechodzą);
   kilka pasujących zleceń → pytanie w „Do sprawdzenia”. Dzień po rozładunku bez zlecenia → „Do sprawdzenia”
   (Zostaw / Usuń). Edycja i usuwanie: panel zlecenia.

9. Zdarzenia dnia (notatka, pauza, naczepa, pozycja auta): „+” pod dniem; kliknięcie w znaczek → popraw albo usuń.
   Godzina jest opcjonalna (znaczek „14:00 · …”). Miejsce przesuwa początek pustego dojazdu tylko w „Pozycji auta” —
   w innych zdarzeniach jest tylko informacją.
   **Zmiana naczepy** wykryta automatycznie (szary, przerywany znaczek „WAW: AB1234P → AB5678P”): kliknięcie →
   dzień, godzina, miejsce, opis. Od tego dnia i godziny auto ma nową naczepę (kolumna po lewej, „Kopiuj”, serwisy
   naczepy); miejsce to tylko informacja. „Usuń — nie było zmiany” chowa znaczek; „Przywróć automatyczną” wraca do
   wykrytej. Gdy automatyczna zmiana zniknie (np. poprawiona naczepa w zleceniu), wpis zostaje jako zwykła „Naczepa”.
10. Kilometry inne niż policzone: panel zlecenia → „Popraw ręcznie” → „Km razem” (wszystkie km auta na zleceniu,
   z ładunkiem i pustym dojazdem). Pusty dojazd zostaje wyliczony przez tablicę, reszta liczy się jako z ładunkiem.
   Starsze poprawki „Km z ładunkiem” / „Km puste” działają dalej (widać je w „Ręcznych poprawkach”, można usunąć).
11. „Czy była przepinka?” w „Do sprawdzenia”: dwa kolejne zlecenia auta są za daleko od siebie jak na czas między nimi
   (z godzinami: pusty dojazd liczony 70 km/h + 4 h zapasu, bo godzina rozładunku z eksportu to koniec okna; bez godzin:
   ponad 500 km pustych tego samego dnia albo załadunek przed rozładunkiem poprzedniego). Zwykle to przepinka bez
   wpisu PRZ — wpisz ją w jednym z dwóch zleceń (z uwag w aplikacji albo „Popraw ręcznie” → „Wpis przepinki (PRZ)”;
   ręczny wpis panel podpisuje „Wpisana na tablicy DD.MM.RR (kto)”), albo popraw datę / godzinę. „W porządku” wycisza
   pozycję, dopóki nie zmienią się daty, godziny albo miejsca.
12. **Doładunek**: w uwagach zlecenia `Doładunek do 79-1234-26` (wielkość liter i polskie znaki bez znaczenia, „do”
   i „-S” opcjonalne) albo panel → „Popraw ręcznie” → „Doładunek do zlecenia” (`-` = to nie doładunek, wbrew uwagom).
   Doładunek jedzie w trasie zlecenia głównego tym samym autem: bez własnych km (z ładunkiem i pustych), nie zmienia
   kolejnych pustych dojazdów ani „Czy była przepinka?”; kwoty liczą się normalnie (i liczy się jako zlecenie).
   Kafelek jasnofioletowy z „doładunek”; panel: „Doładunek do X” z przyciskiem, zlecenie główne: „Doładunki: …”.
   Zlecenie główne na innym aucie, nie ma go na tablicy albo anulowane → zwykłe zlecenie i pozycja w „Do sprawdzenia”.
13. Pozycje „Do sprawdzenia” danego zlecenia (pomarańczowe pola w panelu) mają te same przyciski co na liście —
   można je rozwiązać od razu z panelu; przy różnicy kwot przepinki „Popraw wpis przepinki” otwiera wpis do poprawy.

Ręczne poprawki (panel zlecenia → „Popraw ręcznie”) obowiązują, dopóki aplikacja nie zmieni tej samej wartości —
wtedy tablica bierze nową wartość z aplikacji i zgłasza to na liście.

## Serwis i strona zestawu

- **Serwis** = okres, w którym auto (albo naczepa) jest niedostępne. Nie zmienia km ani kwot.
  - *Wymagany* — przewoźnik zgłasza potrzebę bez terminu (np. „olej”); znacznik wisi przy aucie
    (serwis naczepy — pod numerem naczepy, idzie za naczepą), dopóki go nie zaplanujesz albo nie odwołasz.
  - *Zaplanowany* — od–do z godzinami albo „Cały dzień”. Na tablicy w pasie pod zleceniami: jasny blok = auto
    tego dnia jedzie dalej, pełny = niedostępne, przerywana ramka = naczepa.
  - Dodawanie: „+” pod dniem → Rodzaj „Serwis” albo na stronie zestawu → „Dodaj serwis”. Kliknięcie w blok
    lub znacznik: Zaplanuj / Odłóż (wraca do wymaganych) / Odwołaj / Usuń (pomyłka). Każda zmiana ma historię.
  - Zlecenie w dniu, w którym auto jest cały dzień w serwisie, dostaje czerwoną ramkę.
- **Strona zestawu**: kliknij numer ciągnika na tablicy (albo dwuklik na kolumnę auta, albo Flota → Szczegóły).
  Tydzień / miesiąc, wynik okresu, aktywne zlecenie, zakładki Serwis i Zlecenia. Strona ma własny adres —
  „Wstecz” w przeglądarce wraca na tablicę.

## Kierowcy i certyfikaty

- **Flota → Kierowcy**: lista kierowców (imię i nazwisko, telefon, firma), kto dziś jeździ którym ciągnikiem
  i termin AVSEC. „Certyfikaty” otwiera stronę kierowcy: certyfikaty (AVSEC i inne) ze skanami PDF/JPG/PNG
  do 15 MB — „Podgląd” w nowej karcie, „Pobierz” do wysłania klientowi, „Kopiuj dane” po angielsku.
  Na żółto 30 dni przed końcem ważności, na czerwono po terminie (też przy kierowcy na tablicy).
- **Zmiana kierowcy**: „+” pod dniem → Rodzaj „Zmiana kierowcy” (albo „Zmień kierowcę” na stronie zestawu).
  Od tego dnia (i opcjonalnie godziny) tablica pokazuje nowego kierowcę; jeśli jeździł innym autem, tamto zostaje
  bez kierowcy. Zmianę na tablicy („14:00 → B”) można kliknąć i poprawić albo usunąć.
- **Kierowca zlecenia** liczy się sam: zmiana między dniem załadunku a rozładunku → obaj („A → B (zmiana dd.mm)”),
  w dniu załadunku → nowy, w dniu rozładunku → stary. Z godziną: przed godziną załadunku → nowy, od godziny
  rozładunku → stary, pomiędzy → obaj („A → B (zmiana 28.10 14:00)”). Wyjątki: panel zlecenia → „Popraw ręcznie” → Kierowca.
- **Ciągniki** mają tylko numer, przewoźnika i status; **stały ciągnik naczepy** ustawiasz w zakładce Naczepy.
  - Nowe tablice albo inny ciągnik przewoźnika w miejsce starego: „Nowy numer / nowy ciągnik” od dnia — ten sam
    wiersz, kierowca i historia.
  - Auto odchodzi z działu: „Wycofaj” z ostatnim dniem (i wyborem, czy kierowca przechodzi na inne auto). Do tego
    dnia zostaje w tygodniach, sumach i na stronie zestawu, później go nie ma. Lista „Wycofane z działu” → Przywróć.
    Zlecenie na wycofany numer po ostatnim dniu trafia do „Do sprawdzenia” (Przywróć / Pomiń); po przywróceniu
    wchodzi z najbliższym importem.
  - Odznaczenie „na tablicy” (Edytuj) chowa auto we wszystkich tygodniach, także przeszłych.
- Skany leżą tylko na komputerze biurowym w `data\pliki` (obok bazy); `aktualizuj.cmd` kopiuje je do `data\kopie`.

## Dwa tygodnie równolegle z Excelem

W `cmd` w folderze projektu (Node z fnm: najpierw `set PATH=%USERPROFILE%\.fnm\aliases\default;%PATH%`):

```
npm run board:compare -- --grafik "ŚCIEŻKA\Grafik podwykonawców.xlsm" --from 2026-10-05 --to 2026-10-18
```

Porównuje przychód, koszt, marżę i km per auto i tydzień z grafikiem. Różnice, których się spodziewamy:
przepinki bez wpisu PRZ (w grafiku kwota była dzielona ręcznie), koszty w PLN, skonto (tablica pokazuje koszt
jak w aplikacji), km szacunkowe (≈) zanim HERE policzy dokładne w tle.

## Dostęp z internetu (Cloudflare + Microsoft 365)

Tablica działa dalej na komputerze biurowym, a Cloudflare wystawia ją pod stałym adresem `https://tablica.<domena>`.
Zanim ktokolwiek zobaczy tablicę, Cloudflare Access sprawdza, kto to jest (konto Microsoft 365 albo kod na e-mail),
i wpuszcza tylko adresy z listy. Tablica przyjmuje to logowanie: e-mail z Cloudflare = konto w „Użytkownikach”
(rola jak dotąd), bez hasła tablicy. Hasło tablicy działa wyłącznie na tym komputerze (`localhost`): wejście
z internetu bez potwierdzonego logowania Cloudflare (brak aplikacji Access, źle ustawiona, brak wpisów w `.env`)
kończy się komunikatem o zablokowanym dostępie, nigdy formularzem hasła.

Kolejność: najpierw aplikacja Access (krok 2), potem adres tunelu (krok 3). Nazwy w panelu Cloudflare bywają
zmieniane; szukaj podobnych.

1. **Domena i konto.** Konto Cloudflare na firmowy e-mail, z włączonym logowaniem dwuetapowym. Domena musi mieć DNS
   w Cloudflare: subdomena `zetlogistic.pl` tylko po przeniesieniu DNS całej domeny (to dotyka poczty — decyzja osoby
   od domeny), więc prościej osobna domena tylko na tablicę. Cloudflare nie sprzedaje `.pl` ani `.eu`: `.com` kupisz
   w Cloudflare (Domain Registration), `.pl` u polskiego rejestratora, a potem w Cloudflare „Add a domain” i zmiana
   serwerów nazw u rejestratora. Zero Trust → plan **Free** (do 50 osób) → nazwa zespołu (team name), np. `zet` —
   daje adres `zet.cloudflareaccess.com`.
2. **Aplikacja Access.** Zero Trust → Access → Applications → Add an application → **Self-hosted**:
   - nazwa „Tablica floty”, adres `tablica.<domena>` — cały adres, bez ścieżki; czas sesji np. 1 tydzień;
   - polityka **Allow** → Include → **Emails** → `wojciech.zalubski@zetlogistic.pl` (kolejne osoby dopisujesz tutaj
     i zakładasz im konto w „Użytkownikach” — potrzebne jest jedno i drugie);
   - logowanie: na start tylko **One-time PIN** (kod na e-mail); po kroku 5 — tylko Microsoft (Azure AD);
   - po zapisaniu skopiuj **Application Audience (AUD) Tag** (ustawienia aplikacji).
3. **Tunel.** Zero Trust → Networks → Tunnels → Create a tunnel → **Cloudflared** → nazwa `tablica` → Windows.
   Skopiuj **token** (długi ciąg po `service install`) — samego polecenia instalacji nie uruchamiaj (wymaga
   administratora Windows; tunel startuje u nas z `scripts\tunel.cmd`). Dodaj adres publiczny tunelu
   (Public hostname): subdomena `tablica`, Twoja domena, usługa **HTTP**, adres `127.0.0.1:3001` (nie `localhost`).
   Dodatkowe ustawienia zostaw domyślne — zwłaszcza puste „HTTP Host Header” (inaczej zapisy na tablicy będą
   odrzucane). Nie dodawaj do tego tunelu tras sieci prywatnej (Private Network / CIDR).
4. **`.env` na komputerze biurowym** (ten sam plik co `HERE_API_KEY`) — dopisz:
   ```
   CF_ACCESS_TEAM_DOMAIN=zet.cloudflareaccess.com
   CF_ACCESS_AUD=<AUD tag z kroku 2>
   PUBLIC_HOST=tablica.<domena>
   TUNNEL_TOKEN=<token z kroku 3>
   ```
   Bez `PUBLIC_HOST` (przy ustawionych `CF_ACCESS_*`) serwer nie wystartuje — to celowe.
   Zamknij okno serwera i kliknij `scripts\aktualizuj.cmd`. Serwer otworzy drugie zminimalizowane okno
   „Tablica - tunel Cloudflare” (przy pierwszym razie pobierze `cloudflared` z GitHuba). Test: telefon na danych
   komórkowych → `https://tablica.<domena>` → kod z e-maila → tablica od razu, bez hasła.
5. **Microsoft 365 (Entra ID)** — aplikację rejestrujesz sam (domyślnie może każdy użytkownik), z minimalnymi
   uprawnieniami; administrator M365 potrzebny tylko, gdy M365 poprosi o jego zgodę. Pełna procedura z gotowymi
   wiadomościami do informatyka: dokument „Tablica z internetu — procedura Cloudflare + Microsoft 365” w projekcie.
   - Entra admin center → App registrations → New registration: nazwa „Cloudflare Access - Tablica floty”, single tenant,
     Redirect URI typu **Web**: `https://zet.cloudflareaccess.com/cdn-cgi/access/callback`;
   - Certificates & secrets → New client secret (24 miesiące) → skopiuj **Value** od razu; zapisz w kalendarzu datę
     wygaśnięcia — po niej logowanie Microsoft przestaje działać, dopóki nie wpiszesz nowego sekretu;
   - API permissions → Microsoft Graph → Delegated: `openid`, `email`, `profile`, `offline_access` (+ domyślny `User.Read`).
     Bez `Directory.Read.All` i `GroupMember.Read.All` — są potrzebne tylko do polityk na grupach; dodaj je (ze zgodą
     administratora) dopiero, gdy test w Cloudflare zgłosi „Failed to fetch user/group information”;
   - Cloudflare: Zero Trust → Integrations → Identity providers → Add → **Azure AD**: Application (client) ID,
     client secret, Directory (tenant) ID, Support groups wyłączone → Save → **Test**. „Need admin approval” → administrator
     otwiera `https://login.microsoftonline.com/<tenant ID>/adminconsent?client_id=<client ID>` i akceptuje;
   - w aplikacji Access (krok 2) zaznacz Azure AD, odznacz One-time PIN i włącz „Instant Auth” (działa tylko przy jednej
     metodzie logowania — wtedy strona od razu przechodzi do logowania Microsoft). Gdyby Microsoft kiedyś nie działał
     (np. wygasł sekret), włącz z powrotem One-time PIN.

Gdy Cloudflare przepuści adres bez konta w tablicy, strona pokaże, który adres przyszedł („Brak dostępu do tablicy”) —
dodaj konto z dokładnie tym adresem w „Użytkownikach”. „Wyloguj” wylogowuje z Cloudflare.

Wyłączenie dostępu z internetu: zamknij okno „Tablica - tunel Cloudflare” (wraca przy następnym starcie serwera,
chyba że usuniesz `TUNNEL_TOKEN` z `.env`) albo w Cloudflare usuń adres publiczny tunelu. Aplikacji Access nie
wyłączaj jako sposobu na odcięcie dostępu — to ona jest zabezpieczeniem. Logi tunelu: `logs\tunel.log`.
Komputer biurowy musi być włączony, żeby tablica działała z zewnątrz. `cloudflared` odświeża się sam co 60 dni
(przy starcie tunelu).

## Ustawienia (`.env`)

- `BOARD_HERE=off` — tablica nie odpyta HERE o kilometry (zostają szacunki); domyślnie włączone.
- `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `PUBLIC_HOST`, `TUNNEL_TOKEN` — dostęp z internetu (sekcja wyżej).
  Bez nich tablica działa jak dotąd, tylko na tym komputerze.

## Poza etapem 1

Dashboard finansowy, import historii, historia stawek na trasach w kalkulatorze, uprawnienia ról na tablicy
(na razie każdy zalogowany widzi i edytuje tablicę), notatki dyspozytora o zestawie, certyfikaty pojazdu.
