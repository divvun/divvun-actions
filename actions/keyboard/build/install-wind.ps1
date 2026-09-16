$ErrorActionPreference = 'Stop'

# The available Wind release is x64. Do not try to launch it on x86/ARM64.
$windNativeArch = $env:PROCESSOR_ARCHITEW6432
if (-not $windNativeArch) { $windNativeArch = $env:PROCESSOR_ARCHITECTURE }
if ($windNativeArch -ne 'AMD64') { exit 0 }

# Skip Windows 10 and Server before launching the embedded dependency.
# Wind's own launcher also checks RtlGetVersion before extraction or elevation.
$windWindows = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$windProduct = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\ProductOptions'
if ($windWindows.CurrentMajorVersionNumber -ne 10 -or [int]$windWindows.CurrentBuildNumber -lt 22000 -or $windProduct.ProductType -ne 'WinNT') { exit 0 }

$windInstaller = Join-Path $PSScriptRoot 'divvun-wind-installer.exe'
$windProcess = Start-Process -FilePath $windInstaller -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-' -Wait -PassThru -WindowStyle Hidden
if ($windProcess.ExitCode -notin @(0, 3010, 1641)) {
    [Console]::Error.WriteLine("Divvun Wind installation failed (exit $($windProcess.ExitCode)).")
}
exit $windProcess.ExitCode
