# Tablica floty — etap 1 (wersja lokalna)

Tablica zastępuje roboczy grafik w Excelu: po imporcie eksportu z aplikacji sama układa zlecenia
8 ciągników działu na tygodniu, liczy marżę i kilometry, a wszystko, co wymaga decyzji człowieka,
trafia na listę „Do sprawdzenia”. Kalkulator zostaje osobną zakładką i dzieli z tablicą bazę tras.

## Pierwsze uruchomienie

```bash
git checkout feature/tablica-floty
npm install
cd web && npm install && cd ..

# jednorazowo: auta, kierowcy i naczepy z obecnego grafiku (+ przewoźnicy z eksportu)
npm run board:seed -- --grafik "ŚCIEŻKA/Grafik podwykonawców.xlsm" --export "ŚCIEŻKA/export.xlsx" --curtain KN560PP
```

Seed zapisuje dane do tej samej bazy co kalkulator (`DATABASE_PATH`, domyślnie `data/calculator.sqlite`),
więc trasy policzone w kalkulatorze od razu służą tablicy i odwrotnie. Dane osobowe (kierowcy, telefony,
stawki) zostają w lokalnym pliku bazy — nic nie trafia do repozytorium. Seed można uruchomić ponownie,
nie nadpisuje istniejących wpisów.

## Codzienna praca

```bash
npm run serve          # backend (wymaga HERE_API_KEY, jak kalkulator)
cd web && npm run dev  # interfejs: http://localhost:5173
```

1. W aplikacji: zapisany widok AG Grid (wszyscy klienci, data załadunku od 7 dni wstecz + przyszłe) → eksport .xlsx.
2. Tablica → „Do sprawdzenia” → upuść plik. Import 2–3 razy dziennie.
3. Przejrzyj listę: literówki naczep i miejsc zatwierdza się raz (tablica zapamiętuje), wysoka marża
   zwykle oznacza brak wpisu przepinki, stawka/km poza zakresem — kwotę w PLN.
4. Przepinka: w uwagach zlecenia klienta w aplikacji `PRZ GORZYCZKI 26.04 WGM4518U>KN1050H 700/400`
   (miejsce, data, auto oddające > auto przejmujące, kwota dla każdego auta). Marża = stawka klienta − suma kwot.

Ręczne poprawki (panel zlecenia → „Popraw ręcznie”) obowiązują, dopóki aplikacja nie zmieni tej samej wartości —
wtedy tablica bierze nową wartość z aplikacji i zgłasza to na liście.

## Dwa tygodnie równolegle z Excelem

```bash
npm run board:compare -- --grafik "ŚCIEŻKA/Grafik podwykonawców.xlsm" --from 2026-10-05 --to 2026-10-18
```

Porównuje przychód, koszt, marżę i km per auto i tydzień z grafikiem. Różnice, których się spodziewamy:
przepinki bez wpisu PRZ (w grafiku kwota była dzielona ręcznie), koszty w PLN, skonto (tablica pokazuje koszt
jak w aplikacji), km szacunkowe (≈) zanim HERE policzy dokładne w tle.

## Ustawienia (`.env`)

- `BOARD_USER` — nazwa zapisywana przy notatkach i poprawkach (do czasu wprowadzenia logowania).
- `BOARD_HERE=off` — tablica nie odpyta HERE o kilometry (zostają szacunki); domyślnie włączone.

## Poza etapem 1

Logowanie i serwer (dostęp dla zespołu), dashboard finansowy, import historii, historia stawek na trasach w kalkulatorze.
