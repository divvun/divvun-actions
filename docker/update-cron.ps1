#!/usr/bin/env pwsh

param(
    [string]$ConfigFile = "",
    [string]$Token = ""
)

$ErrorActionPreference = "Stop"

# Configuration
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$UPDATE_SCRIPT = Join-Path $SCRIPT_DIR "update.ps1"
if (-not $ConfigFile) {
    $CONFIG_FILE = Join-Path $SCRIPT_DIR "config-standard-windows.env"
} else {
    $CONFIG_FILE = $ConfigFile
}
$LOCK_FILE = "C:\temp\docker-update.lock"
$LOG_FILE = "C:\logs\docker-update.log"

# Ensure directories exist
$tempDir = "C:\temp"
$logDir = "C:\logs"
if (-not (Test-Path $tempDir)) {
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
}
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

# Ensure log file exists
if (-not (Test-Path $LOG_FILE)) {
    New-Item -ItemType File -Path $LOG_FILE -Force | Out-Null
}

# Function to log with timestamp
function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logEntry = "[$timestamp] $Message"
    Write-Host $logEntry
    Add-Content -Path $LOG_FILE -Value $logEntry
}

# Function to cleanup on exit
function Cleanup {
    if (Test-Path $LOCK_FILE) {
        Remove-Item $LOCK_FILE -Force
    }
}

# Register cleanup on exit
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action { Cleanup } | Out-Null

try {
    # Check if update script exists
    if (-not (Test-Path $UPDATE_SCRIPT)) {
        Write-Log "ERROR: Update script not found at $UPDATE_SCRIPT"
        exit 1
    }

    # Load configuration file if it exists
    if (Test-Path $CONFIG_FILE) {
        Write-Log "Loading configuration from $CONFIG_FILE"
        . $CONFIG_FILE
    } else {
        Write-Log "WARNING: Configuration file not found at $CONFIG_FILE, using defaults"
    }

    # Check for lock file to prevent concurrent runs
    if (Test-Path $LOCK_FILE) {
        $lockContent = Get-Content $LOCK_FILE -ErrorAction SilentlyContinue
        if ($lockContent) {
            $pid = [int]$lockContent
            $process = Get-Process -Id $pid -ErrorAction SilentlyContinue
            if ($process) {
                Write-Log "Update already in progress (PID: $pid). Skipping."
                exit 0
            } else {
                Write-Log "Stale lock file found, removing..."
                Remove-Item $LOCK_FILE -Force
            }
        }
    }

    # Create lock file
    $PID | Out-File -FilePath $LOCK_FILE -Encoding ascii

    # Set BUILDKITE_AGENT_TOKEN from parameter or environment
    if ($Token) {
        $env:BUILDKITE_AGENT_TOKEN = $Token
    }
    
    # Check if BUILDKITE_AGENT_TOKEN is set
    if (-not $env:BUILDKITE_AGENT_TOKEN) {
        Write-Log "ERROR: BUILDKITE_AGENT_TOKEN environment variable or -Token parameter is required"
        exit 1
    }

    Write-Log "Starting Docker update check..."

    # Run the update script and capture output
    $output = & $UPDATE_SCRIPT 2>&1
    $exitCode = $LASTEXITCODE
    
    # Log all output
    foreach ($line in $output) {
        Write-Log "UPDATE: $line"
    }
    
    if ($exitCode -eq 0) {
        Write-Log "Update check completed successfully"
    } else {
        Write-Log "Update check failed with exit code: $exitCode"
        exit $exitCode
    }

    # Log rotation: keep last 1000 lines
    if (Test-Path $LOG_FILE) {
        $content = Get-Content $LOG_FILE | Select-Object -Last 1000
        $content | Out-File $LOG_FILE -Encoding utf8
    }
} finally {
    Cleanup
}