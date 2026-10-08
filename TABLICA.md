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
2. Tablica → „Do sprawdzenia” → upuść plik. Import 2–3 razy dziennie.
3. Przejrzyj listę: literówki naczep i miejsc zatwierdza się raz (tablica zapamiętuje), wysoka marża
   zwykle oznacza brak wpisu przepinki, stawka/km poza zakresem — kwotę w PLN.
4. Przepinka: w uwagach zlecenia klienta w aplikacji `PRZ GORZYCZKI 26.04 WGM4518U>KN1050H 700/400`
   (miejsce, data, auto oddające > auto przejmujące, kwota dla każdego auta). Marża = stawka klienta − suma kwot.

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

## Dwa tygodnie równolegle z Excelem

W `cmd` w folderze projektu (Node z fnm: najpierw `set PATH=%USERPROFILE%\.fnm\aliases\default;%PATH%`):

```
npm run board:compare -- --grafik "ŚCIEŻKA\Grafik podwykonawców.xlsm" --from 2026-10-05 --to 2026-10-18
```

Porównuje przychód, koszt, marżę i km per auto i tydzień z grafikiem. Różnice, których się spodziewamy:
przepinki bez wpisu PRZ (w grafiku kwota była dzielona ręcznie), koszty w PLN, skonto (tablica pokazuje koszt
jak w aplikacji), km szacunkowe (≈) zanim HERE policzy dokładne w tle.

## Ustawienia (`.env`)

- `BOARD_HERE=off` — tablica nie odpyta HERE o kilometry (zostają szacunki); domyślnie włączone.

## Poza etapem 1

Dashboard finansowy, import historii, historia stawek na trasach w kalkulatorze, uprawnienia ról na tablicy
(na razie każdy zalogowany widzi i edytuje tablicę), kierowcy z certyfikatami (paczka B).
