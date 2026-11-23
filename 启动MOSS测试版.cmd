@echo off
chcp 65001 >nul
cd /d "%~dp0"
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start_moss_test.ps1"
if errorlevel 1 pause
