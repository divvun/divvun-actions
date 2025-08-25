#!/usr/bin/env pwsh

param(
    [switch]$Help
)

$ErrorActionPreference = "Stop"

if ($Help) {
    Write-Host "Usage: ./setup-task.ps1"
    Write-Host ""
    Write-Host "This script sets up a Windows Task Scheduler job to run Docker container updates every minute."
    Write-Host ""
    Write-Host "Requirements:"
    Write-Host "  - BUILDKITE_AGENT_TOKEN environment variable must be set"
    Write-Host "  - Script must be run with administrator privileges"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  `$env:BUILDKITE_AGENT_TOKEN = 'your-token-here'"
    Write-Host "  ./setup-task.ps1"
    exit 0
}

# Check if running as administrator
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator"
    exit 1
}

$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$CRON_SCRIPT = Join-Path $SCRIPT_DIR "update-cron.ps1"

# Check if BUILDKITE_AGENT_TOKEN is set
if (-not $env:BUILDKITE_AGENT_TOKEN) {
    Write-Error "BUILDKITE_AGENT_TOKEN environment variable must be set"
    Write-Host "Example: `$env:BUILDKITE_AGENT_TOKEN = 'your-token-here'"
    exit 1
}

if (-not (Test-Path $CRON_SCRIPT)) {
    Write-Error "Cron script not found at: $CRON_SCRIPT"
    exit 1
}

Write-Host "Setting up Windows Task Scheduler job for Docker container updates..."
Write-Host "Script location: $CRON_SCRIPT"

$taskName = "DockerContainerUpdate"

# Remove existing task if it exists
Write-Host "Checking for existing task..."
& schtasks.exe /Query /TN $taskName
if ($LASTEXITCODE -eq 0) {
    Write-Host "Existing task found. Removing..."
    schtasks /Delete /TN $taskName /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to delete existing task"
        exit 1
    }
}

# Build the command - pass token as parameter to avoid environment variable issues
$command = "pwsh.exe -NoProfile -ExecutionPolicy Bypass -File `"$CRON_SCRIPT`" -Token `"$($env:BUILDKITE_AGENT_TOKEN)`""

Write-Host "Creating new scheduled task..."
schtasks /Create `
    /TN $taskName `
    /TR $command `
    /SC MINUTE `
    /MO 1 `
    /RU "NT AUTHORITY\SYSTEM" `
    /RL HIGHEST `
    /F

if ($LASTEXITCODE -eq 0) {
    Write-Host "Task scheduled successfully!"
} else {
    Write-Error "Failed to create scheduled task"
    exit 1
}

Write-Host ""
Write-Host "Windows Task Scheduler job '$taskName' has been created."
Write-Host "The update script will now run every minute to check for new Docker images."
Write-Host ""
Write-Host "To view logs: Get-Content C:\logs\docker-update.log -Tail 50 -Wait"
Write-Host "To remove task: schtasks /Delete /TN '$taskName' /F"
Write-Host ""

# Show task information
Write-Host "Querying task status..."
schtasks /Query /TN $taskName /FO LIST | Select-String "Status|Next Run Time"