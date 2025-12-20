@echo off
:: ZOOM GHOST LAUNCHER - One click, fully automated
powershell -ExecutionPolicy Bypass -Command "Start-Process powershell -ArgumentList '-ExecutionPolicy Bypass -File \"%~dp0zoom-ghost-launcher.ps1\"' -Verb RunAs"
