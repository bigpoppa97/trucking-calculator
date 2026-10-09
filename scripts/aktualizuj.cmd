@echo off
rem ==========================================================================
rem  Aktualizacja kalkulatora i tablicy floty - wystarczy dwuklik.
rem
rem   1) pobiera nowa wersje z GitHuba (git pull)
rem   2) instaluje zaleznosci i buduje interfejs (web\dist)
rem   3) robi kopie bazy (data\kopie) i aktualizuje jej strukture
rem   4) opcjonalnie: wczytuje auta, kierowcow i naczepy z grafiku
rem   5) uruchamia serwer i otwiera przegladarke
rem
rem  Przed uruchomieniem zamknij okno "Kalkulator kosztow - serwer".
rem ==========================================================================
setlocal EnableExtensions
title Aktualizacja - kalkulator i tablica floty
cd /d "%~dp0.."

set "PORT=3001"
if exist ".env" for /f "tokens=1,* delims==" %%A in ('findstr /b /c:"PORT=" ".env"') do set "PORT=%%B"
set "PORT=%PORT: =%"

curl.exe -s -o nul --max-time 3 "http://127.0.0.1:%PORT%/" && goto serwer_dziala

rem Node.js z fnm: alias "default", potem najnowsza zainstalowana wersja, na koncu PATH.
set "NODE="
if exist "%USERPROFILE%\.fnm\aliases\default\node.exe" set "NODE=%USERPROFILE%\.fnm\aliases\default\node.exe"
if not defined NODE for /f "delims=" %%V in ('dir /b /ad /o:d "%USERPROFILE%\.fnm\node-versions\v*" 2^>nul') do if exist "%USERPROFILE%\.fnm\node-versions\%%V\installation\node.exe" set "NODE=%USERPROFILE%\.fnm\node-versions\%%V\installation\node.exe"
if not defined NODE for %%N in (node.exe) do if not "%%~$PATH:N"=="" set "NODE=%%~$PATH:N"
if not defined NODE goto brak_node
for %%D in ("%NODE%") do set "NODEDIR=%%~dpD"
if not exist "%NODEDIR%npm.cmd" goto brak_node
set "PATH=%NODEDIR%;%PATH%"

echo.
echo [1/5] Pobieram nowa wersje z GitHuba...
git pull --ff-only
if errorlevel 1 goto blad_git

echo.
echo [2/5] Instaluje zaleznosci i buduje interfejs (kilka minut przy pierwszym razie)...
call npm install --no-audit --no-fund
if errorlevel 1 goto blad
pushd web
call npm install --no-audit --no-fund
if errorlevel 1 goto blad_web
call npm run build
if errorlevel 1 goto blad_web
popd

echo.
echo [3/5] Kopia bazy i aktualizacja jej struktury...
set "DB=data\calculator.sqlite"
if exist ".env" for /f "tokens=1,* delims==" %%A in ('findstr /b /c:"DATABASE_PATH=" ".env"') do set "DB=%%B"
set "DB=%DB:/=\%"
set "STAMP=kopia"
for /f %%T in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmm"') do set "STAMP=%%T"
if not exist "data\kopie" mkdir "data\kopie"
if exist "%DB%" copy /y "%DB%" "data\kopie\calculator-%STAMP%.sqlite" >nul
if exist "%DB%-wal" copy /y "%DB%-wal" "data\kopie\calculator-%STAMP%.sqlite-wal" >nul
echo Kopia bazy: data\kopie\calculator-%STAMP%.sqlite
rem Skany certyfikatow kierowcow (folder "pliki" obok bazy, chyba ze FILES_DIR w .env).
for %%F in ("%DB%") do set "PLIKI=%%~dpFpliki"
if exist ".env" for /f "tokens=1,* delims==" %%A in ('findstr /b /c:"FILES_DIR=" ".env"') do set "PLIKI=%%B"
set "PLIKI=%PLIKI:/=\%"
if exist "%PLIKI%" robocopy "%PLIKI%" "data\kopie\pliki-%STAMP%" /E /NFL /NDL /NJH /NJS /NP >nul
if exist "%PLIKI%" echo Kopia skanow: data\kopie\pliki-%STAMP%
call npm run migrate
if errorlevel 1 goto blad

echo.
echo [4/5] Tablica floty
choice /c TN /m "Wczytac auta, kierowcow i naczepy z grafiku (pierwsze uruchomienie tablicy)"
if errorlevel 2 goto start_serwera

echo.
echo Przeciagnij do tego okna plik grafiku (.xlsm) i nacisnij Enter:
set "GRAFIK="
set /p "GRAFIK=> "
if not defined GRAFIK goto start_serwera
set "GRAFIK=%GRAFIK:"=%"
echo.
echo Przeciagnij swiezy eksport z aplikacji (.xlsx) - z niego tablica wezmie przewoznikow.
echo Enter = pomin:
set "EKSPORT="
set /p "EKSPORT=> "
if defined EKSPORT set "EKSPORT=%EKSPORT:"=%"
echo.
echo Numery naczep-plandek, oddzielone przecinkami (reszta = chlodnie 2,61 m). Enter = brak:
set "PLANDEKI="
set /p "PLANDEKI=> "

if defined EKSPORT goto seed_z_eksportem
call npm run board:seed -- --grafik "%GRAFIK%" --curtain "%PLANDEKI%"
goto po_seed
:seed_z_eksportem
call npm run board:seed -- --grafik "%GRAFIK%" --export "%EKSPORT%" --curtain "%PLANDEKI%"
:po_seed
if errorlevel 1 goto blad

:start_serwera
echo.
echo [5/5] Uruchamiam serwer...
start "Kalkulator kosztow - serwer" /min "%~dp0kalkulator-serwer.cmd"
timeout /t 8 /nobreak >nul
start "" "http://localhost:%PORT%/"
echo.
echo Gotowe. Tablica: http://localhost:%PORT%  (zaloguj sie swoim kontem kalkulatora)
timeout /t 15
exit /b 0

:serwer_dziala
echo Serwer dziala (port %PORT%). Zamknij okno "Kalkulator kosztow - serwer"
echo na pasku zadan i uruchom aktualizacje jeszcze raz.
pause
exit /b 1

:brak_node
echo Nie znaleziono Node.js ani npm - ani w %USERPROFILE%\.fnm, ani w PATH.
pause
exit /b 1

:blad_git
echo.
echo Nie udalo sie pobrac nowej wersji (git pull). Jesli zmieniales pliki w tym
echo folderze, git ich nie nadpisze - wyslij ten komunikat, pomoge.
pause
exit /b 1

:blad_web
popd
:blad
echo.
echo Cos poszlo nie tak - komunikat powyzej. Serwer nie zostal uruchomiony.
pause
exit /b 1
