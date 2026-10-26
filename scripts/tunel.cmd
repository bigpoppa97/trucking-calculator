@echo off
rem ==========================================================================
rem  Tunel Cloudflare - tablica pod adresem z internetu (np. tablica.twoja-domena)
rem  za Cloudflare Access (logowanie kontem Microsoft 365). Instrukcja: TABLICA.md,
rem  sekcja "Dostep z internetu (Cloudflare)".
rem
rem  Token tunelu: linia TUNNEL_TOKEN=... w pliku .env (ten sam plik co
rem  HERE_API_KEY; nigdy w repozytorium). Bez tokenu skrypt nic nie uruchamia.
rem
rem  Startuje sam razem z serwerem (kalkulator-serwer.cmd). Okno pracuje
rem  zminimalizowane - jego zamkniecie wylacza dostep z internetu; localhost
rem  dziala dalej. Logi: logs\tunel.log
rem ==========================================================================
setlocal EnableExtensions
title Tablica - tunel Cloudflare (nie zamykaj tego okna)
cd /d "%~dp0.."

if not exist "logs" mkdir "logs"
set "LOG=%CD%\logs\tunel.log"

set "TUNNEL_TOKEN="
if exist ".env" for /f "tokens=1,* delims==" %%A in ('findstr /b /c:"TUNNEL_TOKEN=" ".env"') do set "TUNNEL_TOKEN=%%B"
if not defined TUNNEL_TOKEN goto brak_tokenu
set "TUNNEL_TOKEN=%TUNNEL_TOKEN:"=%"
set "TUNNEL_TOKEN=%TUNNEL_TOKEN: =%"
if "%TUNNEL_TOKEN%"=="" goto brak_tokenu

rem Juz dziala? (start serwera po aktualizacji) - nie uruchamiaj drugiej kopii.
rem Szukamy tylko naszego tunelu (cloudflared z logiem logs\tunel.log), nie innych.
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like '*tunel.log*' }; if ($p) { exit 0 } else { exit 1 }" && goto juz_dziala

rem cloudflared: %USERPROFILE%\.cloudflared (pobierany z GitHuba, odswiezany co 60 dni).
set "CF=%USERPROFILE%\.cloudflared\cloudflared.exe"
set "URL=https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
if not exist "%USERPROFILE%\.cloudflared" mkdir "%USERPROFILE%\.cloudflared"
if not exist "%CF%" goto pobierz
powershell -NoProfile -Command "if ((Get-Item -LiteralPath $env:CF).LastWriteTime -lt (Get-Date).AddDays(-60)) { exit 0 } else { exit 1 }" && goto odswiez
goto start

:pobierz
echo Nie ma programu cloudflared - pobieram oficjalne wydanie Cloudflare z GitHuba...
curl.exe -L --fail -o "%CF%" "%URL%"
if errorlevel 1 goto blad_pobierania
goto start

:odswiez
echo Odswiezam cloudflared (wersja starsza niz 60 dni)...
curl.exe -L --fail -o "%CF%.nowy" "%URL%"
if errorlevel 1 goto odswiez_nieudane
move /y "%CF%.nowy" "%CF%" >nul
if errorlevel 1 goto odswiez_nieudane
goto start

:odswiez_nieudane
if exist "%CF%.nowy" del "%CF%.nowy"
>>"%LOG%" echo [%date% %time%] Nie udalo sie odswiezyc cloudflared - zostaje poprzednia wersja.

:start
echo Tablica - tunel Cloudflare
echo.
echo   Program: %CF%
echo   Logi:    %LOG%
echo.
echo   To okno moze byc zminimalizowane. Zamkniecie go wylacza dostep z internetu.
echo.

set /a PROBY=0
:uruchom
>>"%LOG%" echo [%date% %time%] Start tunelu - %CF%
"%CF%" tunnel --no-autoupdate --logfile "%LOG%" run
set "KOD=%ERRORLEVEL%"
>>"%LOG%" echo [%date% %time%] Tunel zatrzymany - kod wyjscia %KOD%
set /a PROBY+=1
if %PROBY% GEQ 20 goto poddaj_sie
echo [%time%] Tunel zatrzymal sie - kod %KOD%. Ponawiam za 30 s...
timeout /t 30 /nobreak >nul
goto uruchom

:poddaj_sie
echo.
echo Tunel zatrzymal sie 20 razy - przerywam. Szczegoly w: %LOG%
pause
exit /b 1

:juz_dziala
echo Tunel juz dziala (cloudflared.exe).
timeout /t 5 >nul
exit /b 0

:brak_tokenu
echo Brak TUNNEL_TOKEN w pliku .env - tunel nie wystartuje.
echo Dopisz w .env linie: TUNNEL_TOKEN=^<token z Cloudflare^> (instrukcja w TABLICA.md).
pause
exit /b 1

:blad_pobierania
>>"%LOG%" echo [%date% %time%] Nie udalo sie pobrac cloudflared.
echo Nie udalo sie pobrac cloudflared. Pobierz recznie plik cloudflared-windows-amd64.exe
echo z https://github.com/cloudflare/cloudflared/releases i zapisz jako:
echo   %USERPROFILE%\.cloudflared\cloudflared.exe
pause
exit /b 1
