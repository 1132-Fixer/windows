@echo off
:: Run PowerShell script as Administrator
powershell -Command "Start-Process powershell -ArgumentList '-ExecutionPolicy Bypass -File \"%~dp0nuke-zoom.ps1\"' -Verb RunAs"
