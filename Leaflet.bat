@echo off
rem Leaflet launcher - this is the "app" Windows runs when you open a .md file.
rem It starts the Leaflet helper hidden, so no console window stays open.
rem Pass -Window tab or -Window maximized after the file to change how it opens.
start "" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0src\Leaflet.ps1" -Path "%~1" %2 %3
