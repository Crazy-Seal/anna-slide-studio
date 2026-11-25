@echo off
REM Anna App entry point: pins uv cache inside the project dir.
REM
REM Usage:
REM   dev.cmd                start local harness (same as: anna-app dev)
REM   dev.cmd validate       run validation
REM   dev.cmd dev --no-llm   pass through any args
REM
REM NOTE: .cmd is used instead of .ps1 because this machine's
REM execution policy is Restricted (PowerShell scripts are blocked).
REM Run "npm install" once before first use.

setlocal
set "UV_CACHE_DIR=%~dp0.uv-cache"

set "CLI=%~dp0node_modules\.bin\anna-app.cmd"
if not exist "%CLI%" (
  echo [error] local CLI not found. Run "npm install" in %~dp0 first.
  exit /b 1
)

if "%~1"=="" (
  "%CLI%" dev
) else (
  "%CLI%" %*
)
exit /b %ERRORLEVEL%
