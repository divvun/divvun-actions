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

Validation on Windows:

```powershell
deno test --frozen --allow-env --allow-read --allow-write --allow-run=powershell.exe actions/keyboard/build/wind_test.ts
```

The hook tests simulate host versions and installer outcomes. They do not
install Wind or register keyboards on the test machine.
