@echo off
title CLIT-OF Bot - Oracle Server Control Panel
cd /d "%~dp0"

echo =========================================================
echo   Starting CLIT-OF Bot Remote Control Panel...
echo =========================================================
echo.

rem Clean up any previous background process on port 4321
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :4321') do (
  taskkill /f /pid %%a >nul 2>&1
)

node tools/control-panel.cjs

pause
