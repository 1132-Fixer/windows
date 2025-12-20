@echo off
powershell -Command "Start-Process powershell -ArgumentList '-ExecutionPolicy Bypass -File \"%~dp0FULL-UNINSTALL.ps1\"' -Verb RunAs"
