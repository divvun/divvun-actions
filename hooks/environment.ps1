# # Set strict mode and error handling
# Set-StrictMode -Version Latest
# $ErrorActionPreference = "Stop"

# # Get plugin directory using the script's location
# $PLUGIN_DIR = (Get-Item (Split-Path -Parent $PSScriptRoot)).FullName

# # Ensure main isn't kept stale
# if ($PLUGIN_DIR -like "*-main") {
#     Push-Location $PLUGIN_DIR
#     git checkout main
#     git pull
#     Pop-Location
# }

# $BAO_ADDR = "https://vault.giellalt.org"
# $BAO_TOKEN = buildkite-agent secret get divvun_actions_openbao_service_token

# # Get role_id and secret_id using bao commands
# $env:BAO_ADDR = $BAO_ADDR
# $env:BAO_TOKEN = $BAO_TOKEN

# $role_id = (bao read -format=json auth/approle/role/builder/role-id | ConvertFrom-Json).data.role_id
# $secret_id = (bao write -format=json -f auth/approle/role/builder/secret-id | ConvertFrom-Json).data.secret_id

# # Add redactions
# echo $role_id | buildkite-agent redactor add
# echo $secret_id | buildkite-agent redactor add

# # Set buildkite metadata
# buildkite-agent meta-data set "divvun_actions_openbao_endpoint" $BAO_ADDR
# buildkite-agent meta-data set "divvun_actions_openbao_role_id" $role_id
# buildkite-agent meta-data set "divvun_actions_openbao_role_secret" $secret_id

# # Set environment variables
# $env:DIVVUN_ACTIONS_PLUGIN_DIR = $PLUGIN_DIR
# $env:PATH = "$PLUGIN_DIR\bin;$env:PATH"

# Write-Host "PowerShell"
# Write-Host $env:PATH

PLUGIN_DIR=$(realpath $(dirname "${BASH_SOURCE[0]}"))
& "C:\msys2\usr\bin\bash.exe" -c "$PLUGIN_DIR/environment"