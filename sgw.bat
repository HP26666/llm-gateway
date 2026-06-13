@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found in PATH.
  exit /b 1
)

echo Starting LLM Gateway...
echo.
node "%SCRIPT_DIR%main.mjs" %*
