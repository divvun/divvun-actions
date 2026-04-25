#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

param(
    [Parameter(Position = 0)]
    [string]$Target,
    [switch]$List
)

Set-Location $PSScriptRoot

if ($List -or $Target -eq "--list" -or $Target -eq "-l") {
    deno run --allow-read --allow-env generate.ts --list
    exit $LASTEXITCODE
}

if (-not $Target) {
    Write-Host "usage: ./build.ps1 <target>     # e.g. windows, windows-vsbase, alpine, linux"
    Write-Host "       ./build.ps1 -List        # show available targets"
    exit 1
}

# windows depends on windows-vsbase being available
if ($Target -eq "windows") {
    $vsbaseRef = (deno run --allow-read --allow-env generate.ts --print-ref=windows-vsbase).Trim()
    $localImage = docker images -q $vsbaseRef
    if (-not $localImage) {
        Write-Warning "Base image $vsbaseRef not found locally. Attempting to pull..."
        docker pull $vsbaseRef
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Failed to pull base image. Run ./build.ps1 windows-vsbase first."
            exit 1
        }
    }
}

deno run --allow-read --allow-write --allow-env generate.ts --only=$Target
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$ref = (deno run --allow-read --allow-env generate.ts --print-ref=$Target).Trim()

$buildArgs = @("build")
if ($Target -eq "windows-vsbase") {
    $buildArgs += @("-m", "8GB")
}
$buildArgs += @("-t", $ref, "-f", "Dockerfile.$Target", ".")

& docker @buildArgs
exit $LASTEXITCODE
