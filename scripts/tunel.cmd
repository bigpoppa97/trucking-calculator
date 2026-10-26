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
tasklist /fi "imagename eq cloudflared.exe" 2>nul | find /i "cloudflared.exe" >nul && goto juz_dziala

rem cloudflared: %USERPROFILE%\.cloudflared, potem PATH, na koncu pobranie z GitHuba.
set "CF=%USERPROFILE%\.cloudflared\cloudflared.exe"
if not exist "%CF%" for %%N in (cloudflared.exe) do if not "%%~$PATH:N"=="" set "CF=%%~$PATH:N"
if not exist "%CF%" goto pobierz
goto start

:pobierz
echo Nie ma programu cloudflared - pobieram oficjalne wydanie Cloudflare z GitHuba...
if not exist "%USERPROFILE%\.cloudflared" mkdir "%USERPROFILE%\.cloudflared"
set "CF=%USERPROFILE%\.cloudflared\cloudflared.exe"
curl.exe -L --fail -o "%CF%" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
if errorlevel 1 goto blad_pobierania

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
