#!/usr/bin/env pwsh

param(
    [string]$Version = "latest",
    [switch]$Force,
    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$LATEST_VERSION = "29.1.1"

if ($Help) {
    Write-Host "Usage: ./upgrade-docker.ps1 [-Version <version>] [-Force]"
    Write-Host ""
    Write-Host "Upgrades Docker on a Windows Server host/VM."
    Write-Host ""
    Write-Host "Parameters:"
    Write-Host "  -Version    Docker version to install (default: 'latest' = $LATEST_VERSION)"
    Write-Host "  -Force      Force upgrade even if already at target version"
    Write-Host "  -Help       Show this help message"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  ./upgrade-docker.ps1                    # Upgrade to latest ($LATEST_VERSION)"
    Write-Host "  ./upgrade-docker.ps1 -Version 28.0.0    # Upgrade to specific version"
    Write-Host "  ./upgrade-docker.ps1 -Force             # Force reinstall"
    exit 0
}

# Check if running as administrator
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator"
    exit 1
}

# Resolve version
$targetVersion = if ($Version -eq "latest") { $LATEST_VERSION } else { $Version }
Write-Host "Target Docker version: $targetVersion"

# Get current Docker version
$currentVersion = $null
try {
    $dockerOutput = & docker --version 2>$null
    if ($dockerOutput -match "Docker version (\d+\.\d+\.\d+)") {
        $currentVersion = $Matches[1]
        Write-Host "Current Docker version: $currentVersion"
    }
} catch {
    Write-Host "Docker not currently installed or not in PATH"
}

# Check if upgrade needed
if ($currentVersion -eq $targetVersion -and -not $Force) {
    Write-Host "Already at version $targetVersion. Use -Force to reinstall."
    exit 0
}

# Check if Docker service exists
$dockerService = Get-Service -Name "docker" -ErrorAction SilentlyContinue
if (-not $dockerService) {
    Write-Error "Docker service not found. This script upgrades existing Docker installations."
    Write-Host "For fresh installs, use: https://docs.docker.com/engine/install/binaries/#install-server-and-client-binaries-on-windows"
    exit 1
}

$dockerPath = "$env:ProgramFiles\Docker"
$downloadUrl = "https://download.docker.com/win/static/stable/x86_64/docker-$targetVersion.zip"
$tempZip = Join-Path $env:TEMP "docker-$targetVersion.zip"

Write-Host ""
Write-Host "Downloading Docker $targetVersion..."
Write-Host "URL: $downloadUrl"

try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $tempZip -UseBasicParsing
} catch {
    Write-Error "Failed to download Docker $targetVersion. Check if version exists: $downloadUrl"
    exit 1
}

Write-Host "Download complete."
Write-Host ""
Write-Host "Stopping Docker service..."
Stop-Service docker -Force
Write-Host "Docker service stopped."

Write-Host "Removing old binaries from $dockerPath..."
Remove-Item -Path "$dockerPath\*" -Recurse -Force

Write-Host "Extracting new binaries..."
Expand-Archive -Path $tempZip -DestinationPath $env:ProgramFiles -Force

Write-Host "Starting Docker service..."
Start-Service docker
Write-Host "Docker service started."

# Cleanup
Remove-Item -Path $tempZip -Force -ErrorAction SilentlyContinue

# Verify
Write-Host ""
$newVersion = $null
try {
    $dockerOutput = & docker --version
    if ($dockerOutput -match "Docker version (\d+\.\d+\.\d+)") {
        $newVersion = $Matches[1]
    }
    Write-Host "Upgrade complete!"
    Write-Host "  Before: $currentVersion"
    Write-Host "  After:  $newVersion"
} catch {
    Write-Error "Failed to verify Docker installation"
    exit 1
}
