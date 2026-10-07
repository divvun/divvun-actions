# Windows keyboard installers

Both the outto and legacy Inno Setup builds bundle the x64 installer from
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
group (`pipelineDesktopKeyboard`), which builds the Inno Setup and outto
installers with the `v4` toolchain (`toolchain.ts`) and uploads them as
build artifacts without deploying them. Other bundles keep the production
steps, with kbdgen and kbdi from pahkat.

The `v4` toolchain downloads kbdgen and the text service installer from the
`v4-latest` prerelease of `divvun/kbdgen`, which kbdgen's `v4` branch
replaces on every build, and the x86 and x64 kbdi from the `v4-latest`
prerelease of `divvun/kbdi`, which kbdi's `v4` branch replaces on every
build (`pipelines/kbdi`), and checks each against its release's
`BLAKE3SUMS`. kbdgen builds the layout DLLs
for x86, x64, Arm64 and WOW64 itself, which needs the i686, x86_64 and
aarch64 `pc-windows-msvc` Rust targets on the agent.

Both v4 installers embed the Divvun keyboard text service, the TSF text
input processor built from kbdgen's `crates/kbd-tsf` (kbdgen spec
`tsf.installer.bundle`), as
`dependencies/divvun-tip/divvun-tip-installer.exe`.

The keyboard installer runs it silently before any `kbdi keyboard_install`,
so kbdi registers each layout's TSF profile. It installs into
`%ProgramFiles%\Divvun\Text Service\<version>`, registers its DLLs with
regsvr32, deletes older versions (at restart while loaded), and refuses to
replace a newer version. A failure leaves the keyboards on their layouts.

On uninstall the keyboard runs `kbdi keyboard_uninstall` for its layouts and
then the text service's uninstaller, which refuses while any keyboard's
profile remains under its CLSID in `CTF\TIP`. The last keyboard removed
therefore removes the text service.

Validation on Windows:

```powershell
deno test --frozen --allow-env --allow-read --allow-write --allow-run=powershell.exe actions/keyboard/build/wind_test.ts
```

The hook tests simulate host versions and installer outcomes. They do not
install Wind or register keyboards on the test machine.
