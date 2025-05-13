# Set strict mode and error handling
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Get plugin directory using the script's location
$PLUGIN_DIR = (Get-Item (Split-Path -Parent $PSScriptRoot)).FullName

# Ensure main isn't kept stale
if ($PLUGIN_DIR -like "*-main") {
    Push-Location $PLUGIN_DIR
    git checkout main
    git pull
    Pop-Location
}

# Set environment variables
$env:DIVVUN_ACTIONS_PLUGIN_DIR = $PLUGIN_DIR
$env:PATH = "$PLUGIN_DIR\bin;$env:PATH"

Write-Host "PowerShell"
Write-Host $env:PATH