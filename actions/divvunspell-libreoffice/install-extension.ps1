# Register or deregister the divvunspell-libreoffice .oxt into the shared
# (all-users) extension cache of every LibreOffice install on the system,
# using oxtreg (no unopkg, no LibreOffice tooling).
#
# Usage:
#   install-extension.ps1 -Action add    -Target <path-to-oxt>
#   install-extension.ps1 -Action remove -Target <extension-id>
#
# outto runs this elevated from the installer's after_install / before_uninstall
# hook. oxtreg --shared writes <install>\share\uno_packages\cache directly, so
# the extension is registered for all users (picked up on each user's next
# launch). Exits 0 when no LibreOffice is found so the hook does not fail.

param(
    [Parameter(Mandatory=$true)][ValidateSet('add','remove')][string]$Action,
    [Parameter(Mandatory=$true)][string]$Target
)

$ErrorActionPreference = 'Continue'

$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
$oxtreg = Join-Path $here 'oxtreg.exe'
if (-not (Test-Path $oxtreg)) {
    Write-Error "[divvunspell-libreoffice] oxtreg not found at $oxtreg"
    exit 1
}

$subcommand = if ($Action -eq 'add') { 'install' } else { 'uninstall' }

$searchRoots = @(
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)}
) | Where-Object { $_ -and (Test-Path $_) }

$found = $false
foreach ($root in $searchRoots) {
    Get-ChildItem -Path $root -Filter 'LibreOffice*' -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $install = $_.FullName
        # A real install has program\soffice.exe; skip stray directories.
        if (-not (Test-Path (Join-Path $install 'program\soffice.exe'))) { return }

        $found = $true
        Write-Host "[divvunspell-libreoffice] $subcommand (shared) for $install via oxtreg"

        & $oxtreg '--shared' $install $subcommand $Target
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[divvunspell-libreoffice] oxtreg exited $LASTEXITCODE for $install (continuing)"
        }
    }
}

if (-not $found) {
    Write-Host '[divvunspell-libreoffice] No LibreOffice installation found; skipping.'
}

exit 0
