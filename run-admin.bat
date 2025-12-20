@echo off
:: Run Zoom 1132 Eliminator as Administrator
powershell -Command "Start-Process cmd -ArgumentList '/c cd /d \"%~dp0\" && npm start' -Verb RunAs"
