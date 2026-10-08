@echo off
rem ==========================================================================
rem  Wylacza autostart kalkulatora (usuwa skrot z folderu Autostart).
rem  Dzialajacy serwer zatrzymasz, zamykajac jego okno na pasku zadan.
rem ==========================================================================
powershell -NoProfile -Command "$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Kalkulator kosztow.lnk'; if (Test-Path $lnk) { Remove-Item $lnk; 'Autostart wylaczony.' } else { 'Autostart nie byl wlaczony.' }"
echo Dzialajacy serwer zatrzymasz, zamykajac okno "Kalkulator kosztow - serwer".
timeout /t 10
