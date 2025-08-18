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

# Set tmpdir to something we control
$tempPrefix = "build.$env:BUILDKITE_PIPELINE_NAME.$env:BUILDKITE_BUILD_NUMBER."
$tempDir = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), [System.IO.Path]::GetRandomFileName())
$tempDir = $tempDir -replace [System.IO.Path]::GetFileName($tempDir), ($tempPrefix + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
$env:TMP = $tempDir
$env:TEMP = $tempDir
Write-Host "Using temporary directory: $tempDir"

Write-Host "PowerShell"
Write-Host $env:PATH