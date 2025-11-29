# Check if base image exists locally or can be pulled
$baseImage = docker images -q ghcr.io/divvun/lts-windowsservercore-ltsc2022-vs2022:latest
if (-not $baseImage) {
    Write-Warning "Base image not found locally. Attempting to pull..."
    docker pull ghcr.io/divvun/lts-windowsservercore-ltsc2022-vs2022:latest
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to pull base image. Run build-vsbase.ps1 first to build it."
        exit 1
    }
}

& docker build -t ghcr.io/divvun/divvun-actions:windows-latest -f .\Dockerfile.windows .
