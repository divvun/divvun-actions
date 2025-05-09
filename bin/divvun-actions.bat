@echo off
deno -q run -A main.ts %*
exit /b %errorlevel%
