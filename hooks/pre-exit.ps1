# Set strict mode and error handling
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

echo "Cleaning up temporary directory ($env:TMP)..."
Remove-Item -Path $env:TMP -Recurse -Force

