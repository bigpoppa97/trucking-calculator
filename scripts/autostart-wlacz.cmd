@echo off
rem ==========================================================================
rem  Wlacza autostart kalkulatora: dodaje skrot "Kalkulator kosztow" do folderu
rem  Autostart biezacego uzytkownika (bez uprawnien administratora) i od razu
rem  uruchamia serwer. Wystarczy kliknac dwukrotnie - raz.
rem ==========================================================================
setlocal
set "CEL=%~dp0kalkulator-serwer.cmd"

powershell -NoProfile -Command "$ErrorActionPreference = 'Stop'; $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Kalkulator kosztow.lnk'; $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk); $s.TargetPath = $env:CEL; $s.WorkingDirectory = Split-Path $env:CEL; $s.WindowStyle = 7; $s.Description = 'Kalkulator kosztow - serwer'; $s.Save(); Write-Host ('Dodano skrot: ' + $lnk)"
if errorlevel 1 goto blad

echo.
echo Autostart wlaczony - kalkulator wystartuje przy kazdym logowaniu do Windows.
echo Uruchamiam go teraz (okno zminimalizowane na pasku zadan)...
start "Kalkulator kosztow - serwer" /min "%CEL%"
echo.
echo Gotowe. Kalkulator: http://localhost:3001
timeout /t 10
exit /b 0

:blad
echo.
echo Nie udalo sie dodac skrotu do Autostartu.
pause
exit /b 1
