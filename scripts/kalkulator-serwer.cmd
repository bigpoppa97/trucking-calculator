@echo off
rem ==========================================================================
rem  Kalkulator kosztow - serwer (interfejs + API na jednym porcie, z .env)
rem
rem  Startuje automatycznie przy logowaniu do Windows (skrot w Autostarcie,
rem  dodawany przez autostart-wlacz.cmd). Okno pracuje zminimalizowane na
rem  pasku zadan - jego zamkniecie zatrzymuje kalkulator.
rem  Logi serwera: logs\serwer.log
rem ==========================================================================
setlocal EnableExtensions
title Kalkulator kosztow - serwer (nie zamykaj tego okna)
cd /d "%~dp0.."

if not exist "logs" mkdir "logs"
set "LOG=%CD%\logs\serwer.log"

if not exist ".env" goto brak_env

rem Port z .env (domyslnie 3001)
set "PORT=3001"
for /f "tokens=1,* delims==" %%A in ('findstr /b /c:"PORT=" ".env"') do set "PORT=%%B"
set "PORT=%PORT: =%"

rem Juz dziala? (np. skrot odpalony drugi raz) - nie startuj drugiej kopii.
curl.exe -s -o nul --max-time 3 "http://127.0.0.1:%PORT%/" && goto juz_dziala

rem Node.js z fnm: alias "default", potem najnowsza zainstalowana wersja, na koncu PATH.
set "NODE="
if exist "%USERPROFILE%\.fnm\aliases\default\node.exe" set "NODE=%USERPROFILE%\.fnm\aliases\default\node.exe"
if not defined NODE for /f "delims=" %%V in ('dir /b /ad /o:d "%USERPROFILE%\.fnm\node-versions\v*" 2^>nul') do if exist "%USERPROFILE%\.fnm\node-versions\%%V\installation\node.exe" set "NODE=%USERPROFILE%\.fnm\node-versions\%%V\installation\node.exe"
if not defined NODE for %%N in (node.exe) do if not "%%~$PATH:N"=="" set "NODE=%%~$PATH:N"
if not defined NODE goto brak_node

echo Kalkulator kosztow - serwer
echo.
echo   Adres:  http://localhost:%PORT%
echo   Logi:   %LOG%
echo.
echo   To okno moze byc zminimalizowane. Zamkniecie go zatrzymuje kalkulator.
echo.

set /a PROBY=0
:uruchom
>>"%LOG%" echo [%date% %time%] Start serwera - node: %NODE%
"%NODE%" --env-file=.env --import tsx src/server/index.ts >>"%LOG%" 2>&1
set "KOD=%ERRORLEVEL%"
>>"%LOG%" echo [%date% %time%] Serwer zatrzymany - kod wyjscia %KOD%
set /a PROBY+=1
if %PROBY% GEQ 5 goto poddaj_sie
echo [%time%] Serwer zatrzymal sie - kod %KOD%. Ponawiam za 15 s...
timeout /t 15 /nobreak >nul
goto uruchom

:poddaj_sie
echo.
echo Serwer zatrzymal sie 5 razy - przerywam. Szczegoly w: %LOG%
pause
exit /b 1

:juz_dziala
>>"%LOG%" echo [%date% %time%] Pominieto start - port %PORT% juz odpowiada.
echo Kalkulator juz dziala: http://localhost:%PORT%
timeout /t 5 >nul
exit /b 0

:brak_env
>>"%LOG%" echo [%date% %time%] Brak pliku .env - serwer nie wystartuje bez HERE_API_KEY.
echo Brak pliku .env w %CD% - serwer nie wystartuje bez HERE_API_KEY.
pause
exit /b 1

:brak_node
>>"%LOG%" echo [%date% %time%] Nie znaleziono Node.js.
echo Nie znaleziono Node.js - ani w %USERPROFILE%\.fnm, ani w PATH.
pause
exit /b 1
