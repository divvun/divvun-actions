param(
    [Parameter(Mandatory)][string]$Archive,
    [Parameter(Mandatory)][string]$Member,
    [Parameter(Mandatory)][string]$Output
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$windArchive = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
    $windEntry = $windArchive.GetEntry($Member)
    if ($null -eq $windEntry) { throw "Missing debugger package member: $Member" }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($windEntry, $Output, $true)
} finally {
    $windArchive.Dispose()
}
$windSignature = Get-AuthenticodeSignature -LiteralPath $Output
if ($windSignature.Status -ne 'Valid' -or $windSignature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
    throw "Invalid Microsoft signature on $Output"
}
