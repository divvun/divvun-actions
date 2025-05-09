@echo off
setlocal

set "SCRIPT_DIR=%~dp0.."

deno -q run -A "%SCRIPT_DIR%\main.ts" %*
exit /b %errorlevel%
