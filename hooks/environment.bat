@echo off
setlocal EnableDelayedExpansion

:: Get plugin directory (parent of hooks directory)
pushd %~dp0\..
set "PLUGIN_DIR=%CD%"
popd

:: Ensure main isn't kept stale
echo %PLUGIN_DIR% | findstr /C:"-main" >nul
if not errorlevel 1 (
    git -C "%PLUGIN_DIR%" checkout main
    git -C "%PLUGIN_DIR%" pull
)

:: Set OpenBao address
set "BAO_ADDR=https://vault.giellalt.org"
for /f "tokens=*" %%i in ('buildkite-agent secret get divvun_actions_openbao_service_token') do set "BAO_TOKEN=%%i"

:: Get role_id and secret_id
for /f "tokens=*" %%i in ('bao read -format^=json auth/approle/role/builder/role-id') do set "role_id_json=%%i"
for /f "tokens=*" %%i in ('echo !role_id_json! ^| jq -r .data.role_id') do set "role_id=%%i"

for /f "tokens=*" %%i in ('bao write -format^=json -f auth/approle/role/builder/secret-id') do set "secret_id_json=%%i"
for /f "tokens=*" %%i in ('echo !secret_id_json! ^| jq -r .data.secret_id') do set "secret_id=%%i"

:: Add redactions
buildkite-agent redactor add "!role_id!"
buildkite-agent redactor add "!secret_id!"

:: Set buildkite metadata
buildkite-agent meta-data set "divvun_actions_openbao_endpoint" "%BAO_ADDR%"
buildkite-agent meta-data set "divvun_actions_openbao_role_id" "!role_id!"
buildkite-agent meta-data set "divvun_actions_openbao_role_secret" "!secret_id!"

:: Set environment variables
set "DIVVUN_ACTIONS_PLUGIN_DIR=%PLUGIN_DIR%"
echo %PATH%
set "PATH=%PLUGIN_DIR%\bin;%PATH%"

endlocal & (
    set "PATH=%PATH%"
    set "DIVVUN_ACTIONS_PLUGIN_DIR=%PLUGIN_DIR%"
)