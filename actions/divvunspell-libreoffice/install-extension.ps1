# Register or deregister the divvunspell-libreoffice .oxt against every
# LibreOffice install discovered on the system.
#
# Usage:
#   install-extension.ps1 -Action add    -Target <path-to-oxt>
#   install-extension.ps1 -Action remove -Target <extension-id>
#
# Exits 0 even if no LibreOffice is found. Per-install failures are logged
# but do not abort the loop.

param(
    [Parameter(Mandatory=$true)][ValidateSet('add','remove')][string]$Action,
    [Parameter(Mandatory=$true)][string]$Target
)

$ErrorActionPreference = 'Continue'

$searchRoots = @(
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)}
) | Where-Object { $_ -and (Test-Path $_) }

$found = $false
foreach ($root in $searchRoots) {
    Get-ChildItem -Path $root -Filter 'LibreOffice*' -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $unopkg = Join-Path $_.FullName 'program\unopkg.exe'
        if (Test-Path $unopkg) {
            $found = $true
            Write-Host "[divvunspell-libreoffice] $Action via $unopkg"

            $extra = @()
            if ($Action -eq 'add') { $extra += '--suppress-license' }

            & $unopkg $Action '--shared' @extra $Target
            if ($LASTEXITCODE -ne 0) {
                Write-Host "[divvunspell-libreoffice] $unopkg exited $LASTEXITCODE (continuing)"
            }
        }
    }
}

if (-not $found) {
    Write-Host '[divvunspell-libreoffice] No LibreOffice installation found; skipping.'
}

exit 0
