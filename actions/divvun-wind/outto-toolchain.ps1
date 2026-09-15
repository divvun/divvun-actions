$ErrorActionPreference = 'Stop'
$windOutto = (Get-Command outto -CommandType Application).Source
$windToolRoot = Split-Path (Split-Path $windOutto -Parent) -Parent
$windToolFiles = @(
    $windOutto,
    (Join-Path $windToolRoot 'libexec/outto-gui.exe'),
    (Join-Path $windToolRoot 'libexec/outto-uninstall.exe')
)
$windToolFiles | ForEach-Object {
    # A missing uninstaller is a packaging failure, not an optional warning.
    $windHash = Get-FileHash -LiteralPath $_ -Algorithm SHA256
    [pscustomobject]@{ name = [IO.Path]::GetFileName($_); sha256 = $windHash.Hash.ToLowerInvariant() }
} | ConvertTo-Json
