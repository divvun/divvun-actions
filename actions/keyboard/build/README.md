# Windows keyboard installers

The outto and Inno Setup builds bundle the x64 installer from
`divvun/divvun-wind`'s `dev-latest` release. The build downloads it through the
authenticated GitHub CLI, checks its entry in `BLAKE3SUMS`, and embeds it with
`install-wind.ps1`. Missing, ambiguous or mismatched downloads fail the build.
The existing CI GitHub token needs read access to the private Wind repository.

Keyboard installation runs the embedded Wind installer silently on Windows 11
x64, waits for completion, and suppresses automatic restarts. The hook skips
Windows 10, Windows Server, x86 and ARM64. No install-time download is needed.
Wind starts at the user's next logon, following its own installer contract.

Wind remains an independently installed, shared product. Removing one keyboard
removes that keyboard's bundled setup files but does not uninstall Wind or
remove other keyboards' data.

## kbdgen v4 and the Divvun Text Service

A keyboard bundle with a format 4 layout gets only the "kbdgen v4 (test)"
group (`pipelineDesktopKeyboard`), which builds the outto installer with the
`v4` toolchain (`toolchain.ts`) and uploads it as a build artifact; kbdgen v4
keyboards get no Inno Setup installer. Other bundles keep the production
steps, with kbdgen and kbdi from pahkat.

Pushes to the keyboard's `v4` branch also deploy the signed installer
(`runDesktopKeyboardDeployWindowsV4`). It is added to the keyboard
repository's rolling `v4-latest` prerelease as
`<repo>-kbdgen-v4-outto_<version>_windows.exe`, replacing the previous
build's assets as production's `dev-latest` does. Its download URL becomes the Windows payload of a
`nightly` release of the keyboard's package in `https://pahkat.uit.no/main/`,
the production one, versioned with the installer's own version, which outto
registers as the Add/Remove Programs `DisplayVersion`. The payload is of kind
`inno`, so pahkat installs it with `/VERYSILENT /SP- /SUPPRESSMSGBOXES
/NORESTART`; its product code is the outto package id,
`no.divvun.keyboard.<name>`, and its `uninstall_args`, `/VERYSILENT
/SUPPRESSMSGBOXES /NORESTART`, replace the `--dir` that the install's
`QuietUninstallString` passes, which the uninstaller does without.

The `v4` toolchain downloads kbdgen and the text service installer from the
`v4-latest` prerelease of `divvun/kbdgen`, which kbdgen's `v4` branch
replaces on every build, and the x86 and x64 kbdi from the `v4-latest`
prerelease of `divvun/kbdi`, which kbdi's `v4` branch replaces on every
build (`pipelines/kbdi`), and checks each against its release's
`BLAKE3SUMS`. kbdgen builds the layout DLLs
for x86, x64, Arm64 and WOW64 itself, which needs the i686, x86_64 and
aarch64 `pc-windows-msvc` Rust targets on the agent.

The v4 installer embeds the Divvun keyboard text service, the TSF text
input processor built from kbdgen's `crates/kbd-tsf` (kbdgen spec
`tsf.installer.bundle`), as
`dependencies/divvun-tip/divvun-tip-installer.exe`. That is itself an outto
installer (`actions/kbd-tsf/installer.ts`), built and published by the
kbdgen pipeline (`pipelines/kbdgen/tip.ts`).

The keyboard installer runs it silently before any `kbdi keyboard_install`,
so kbdi registers each layout's TSF profile. It installs into
`%ProgramFiles%\Divvun\Text Service\<version>`, registers its DLLs with
regsvr32, deletes older versions (moving loaded DLLs aside until the next
restart), refuses to replace a newer version, and takes over a text service
that the earlier Inno Setup installer installed. A failure leaves the
keyboards on their layouts.

On uninstall the keyboard runs `kbdi keyboard_uninstall` for its layouts and
then the text service's uninstaller,
`%ProgramFiles%\Divvun\Text Service\.outto\no.divvun.text-service\uninstall.exe`,
which exits 2 without changing anything while any keyboard's profile remains
under its CLSID in `CTF\TIP`. The last keyboard removed therefore removes
the text service.

Validation on Windows:

```powershell
deno test --frozen --allow-env --allow-read --allow-write --allow-run=powershell.exe actions/keyboard/build/wind_test.ts
```

The hook tests simulate host versions and installer outcomes. They do not
install Wind or register keyboards on the test machine.
