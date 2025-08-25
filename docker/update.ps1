#!/usr/bin/env pwsh

param(
    [switch]$Force,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

# Parse command line arguments
if ($Help) {
    Write-Host "Usage: ./update.ps1 [OPTIONS]"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -Force        Force update even if image hasn't changed"
    Write-Host "  -Help         Show this help message"
    Write-Host ""
    Write-Host "Environment Variables:"
    Write-Host "  BUILDKITE_AGENT_TOKEN    Required: Buildkite agent token"
    Write-Host "  INSTANCE_COUNT           Number of builder instances (default: 2)"
    Write-Host "  CONTAINER_PREFIX         Container name prefix (default: 'builder-')"
    Write-Host "  QUEUE_TAGS               Buildkite queue tags (default: 'queue=windows')"
    exit 0
}

# Configuration with defaults
$INSTANCE_COUNT = if ($env:INSTANCE_COUNT) { $env:INSTANCE_COUNT } else { 2 }
$CONTAINER_PREFIX = if ($env:CONTAINER_PREFIX) { $env:CONTAINER_PREFIX } else { "builder-" }
$QUEUE_TAGS = if ($env:QUEUE_TAGS) { $env:QUEUE_TAGS } else { "queue=windows" }
$IMAGE_NAME = "ghcr.io/divvun/divvun-actions:windows-latest"

# Check required environment variables
if (-not $env:BUILDKITE_AGENT_TOKEN) {
    Write-Error "BUILDKITE_AGENT_TOKEN environment variable is required"
    exit 1
}

Write-Host "Configuration:"
Write-Host "  Instance Count: $INSTANCE_COUNT"
Write-Host "  Container Prefix: $CONTAINER_PREFIX"
Write-Host "  Queue Tags: $QUEUE_TAGS"
Write-Host "  Image: $IMAGE_NAME"
Write-Host "  Force Update: $Force"
Write-Host ""

# Get current image ID
Write-Host "Checking current image..."
$CURRENT_IMAGE_ID = ""
try {
    $CURRENT_IMAGE_ID = docker image inspect $IMAGE_NAME --format '{{.Id}}' 2>$null
} catch {
    # Image doesn't exist locally
}

# Pull latest image
Write-Host "Pulling latest image..."
docker pull $IMAGE_NAME
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to pull image"
    exit 1
}

# Get new image ID
$NEW_IMAGE_ID = docker image inspect $IMAGE_NAME --format '{{.Id}}'
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to inspect image"
    exit 1
}

# Check if image has changed or force update is requested
if (($CURRENT_IMAGE_ID -eq $NEW_IMAGE_ID) -and ($CURRENT_IMAGE_ID -ne "") -and (-not $Force)) {
    Write-Host "Image has not changed. No update needed."
    Write-Host "Use -Force to update anyway."
    exit 0
}

if ($Force) {
    Write-Host "Force update requested. Updating containers..."
} else {
    Write-Host "Image has changed. Updating containers..."
}

# Function to update a single container
function Update-Container {
    param([int]$N, [string]$ContainerPrefix, [string]$QueueTags, [string]$ImageName, [string]$Token)
    
    $CONTAINER_NAME = "$ContainerPrefix$N"
    Write-Host "[$N] Starting update process for $CONTAINER_NAME..."
    
    # Stop if exists
    $containerExists = docker ps -q --filter "name=$CONTAINER_NAME" 2>$null
    if ($containerExists -and $LASTEXITCODE -eq 0) {
        Write-Host "[$N] Stopping $CONTAINER_NAME (gracefully, may take up to 30+ minutes for running builds)..."
        docker stop --timeout=-1 $CONTAINER_NAME
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[$N] $CONTAINER_NAME stopped successfully"
        } else {
            Write-Host "[$N] Failed to stop $CONTAINER_NAME (may not exist)"
        }
    } else {
        Write-Host "[$N] $CONTAINER_NAME is not running, skipping stop"
    }
    
    # Remove
    Write-Host "[$N] Removing $CONTAINER_NAME..."
    docker rm $CONTAINER_NAME 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[$N] Container $CONTAINER_NAME already removed or doesn't exist"
    }
    
    # Recreate
    Write-Host "[$N] Creating new $CONTAINER_NAME..."
    docker run `
        -d `
        -v "D:\buildkite\secrets:C:\buildkite-secrets" `
        --volume "//./pipe/docker_engine://./pipe/docker_engine" `
        -v "D:\buildkite\hooks:C:\buildkite-agent\hooks:ro" `
        --name $CONTAINER_NAME `
        --restart=unless-stopped `
        $ImageName `
        buildkite-agent start `
        --token "$Token" `
        --tags-from-host --tags $QueueTags `
        --shell="pwsh -Command"
        
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[$N] ✓ $CONTAINER_NAME updated successfully!"
    } else {
        Write-Host "[$N] ✗ Failed to create $CONTAINER_NAME"
    }
}

# Update all containers in parallel
Write-Host "Starting container updates..."
Write-Host ""

$jobs = @()
for ($N = 1; $N -le $INSTANCE_COUNT; $N++) {
    $job = Start-Job -ScriptBlock ${function:Update-Container} -ArgumentList $N,$CONTAINER_PREFIX,$QUEUE_TAGS,$IMAGE_NAME,$env:BUILDKITE_AGENT_TOKEN
    $jobs += $job
}

Write-Host "All container updates started in parallel. Waiting for completion..."
$jobs | Wait-Job | Receive-Job
$jobs | Remove-Job

Write-Host ""
Write-Host "All container updates completed!"

Write-Host "Update completed successfully!"
Write-Host "Active containers:"
docker ps --filter "name=$CONTAINER_PREFIX" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"

Write-Host ""
Write-Host "Cleaning up unused Docker resources..."
docker container prune -f
docker image prune -f
docker volume prune -f
docker network prune -f
Write-Host "Docker cleanup completed!"