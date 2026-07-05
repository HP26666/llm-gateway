@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found in PATH.
  exit /b 1
)

REM Background service mode: no interactive CLI, request logs print to this terminal.
REM Edit config (providers/keys/models/families) via sgw; config lives in data/gateway.json.
node "%SCRIPT_DIR%serve.mjs" %*
