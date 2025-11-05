@echo off
setlocal

set "SCRIPT_DIR=%~dp0.."

REM Log that the batch file was called
echo [BAT] Called with args: %* >> "%SCRIPT_DIR%\.divvun-bat-debug.log" 2>&1
echo [BAT] SCRIPT_DIR: %SCRIPT_DIR% >> "%SCRIPT_DIR%\.divvun-bat-debug.log" 2>&1
echo [BAT] CWD: %CD% >> "%SCRIPT_DIR%\.divvun-bat-debug.log" 2>&1

deno -q run -A "%SCRIPT_DIR%\main.ts" %*
set DENO_EXIT=%errorlevel%
echo [BAT] Deno exited with code: %DENO_EXIT% >> "%SCRIPT_DIR%\.divvun-bat-debug.log" 2>&1
exit /b %DENO_EXIT%
