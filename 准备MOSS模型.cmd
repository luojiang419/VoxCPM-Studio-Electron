@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONUTF8=1
python "%~dp0scripts\prepare_moss.py"
pause
