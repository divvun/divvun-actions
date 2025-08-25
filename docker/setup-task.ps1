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
$taskDescription = "Automatically update Docker containers when new images are available"

# Remove existing task if it exists
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Write-Host "Existing task found. Removing..."
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

# Create task action
$action = New-ScheduledTaskAction -Execute "pwsh.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$CRON_SCRIPT`""

# Create task trigger (every minute)
$trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 365) -At (Get-Date)

# Create task settings
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RunOnlyIfNetworkAvailable

# Create task principal (run as SYSTEM)
$principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest

# Set environment variables for the task
$envVars = @{
    "BUILDKITE_AGENT_TOKEN" = $env:BUILDKITE_AGENT_TOKEN
}

# Build environment variable string for task action
$envString = ""
foreach ($key in $envVars.Keys) {
    $envString += "`$env:$key = '$($envVars[$key])'; "
}

# Update action with environment variables
$action = New-ScheduledTaskAction -Execute "pwsh.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -Command `"$envString & '$CRON_SCRIPT'`""

# Register the task
try {
    Register-ScheduledTask -TaskName $taskName -Description $taskDescription -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Write-Host "Task scheduled successfully!"
} catch {
    Write-Error "Failed to register scheduled task: $($_.Exception.Message)"
    exit 1
}

Write-Host ""
Write-Host "Windows Task Scheduler job '$taskName' has been created."
Write-Host "The update script will now run every minute to check for new Docker images."
Write-Host ""
Write-Host "To view logs: Get-Content C:\logs\docker-update.log -Tail 50 -Wait"
Write-Host "To remove task: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
Write-Host ""

# Show task information
try {
    $task = Get-ScheduledTask -TaskName $taskName
    Write-Host "Task Status: $($task.State)"
    Write-Host "Next Run Time: $((Get-ScheduledTask -TaskName $taskName | Get-ScheduledTaskInfo).NextRunTime)"
} catch {
    Write-Warning "Could not retrieve task information"
}