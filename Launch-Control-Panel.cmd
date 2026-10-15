@echo off
title CLIT-OF Bot - Oracle Server Control Panel
cd /d "%~dp0"

echo =========================================================
echo   Starting CLIT-OF Bot Remote Control Panel...
echo =========================================================
echo.

node tools/control-panel.cjs

pause
