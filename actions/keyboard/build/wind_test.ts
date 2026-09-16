import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict"
import * as path from "@std/path"
import * as toml from "@std/toml"
import { blake3Hash } from "~/util/hash.ts"
import { OuttoBuilder } from "~/util/outto.ts"
import { makeTempDir } from "~/util/temp.ts"

Deno.env.set("BUILDKITE", "true")
Deno.env.set("BUILDKITE_REPO", "git@github.com:divvun/divvun-actions.git")
const { addWindToOutto, verifyWindDownload } = await import("./wind.ts")

Deno.test("Wind dependency rejects wrong, ambiguous, unsigned and corrupt downloads", async () => {
  using scratch = await makeTempDir({ prefix: "keyboard-wind-test-" })
  try {
    const name = "divvun-wind_x86-64-pc-windows-msvc_0.1.0.exe"
    const artifact = path.join(scratch.path, name)
    const sums = path.join(scratch.path, "BLAKE3SUMS")
    await Deno.writeTextFile(sums, "")
    await Deno.writeTextFile(
      path.join(scratch.path, "divvun-wind_aarch64-pc-windows-msvc_0.1.0.exe"),
      "wrong arch",
    )
    await Deno.writeTextFile(
      path.join(scratch.path, name.replace(".exe", ".UNSIGNED.exe")),
      "unsigned",
    )
    await rejects(verifyWindDownload(scratch.path), /found 0/)
    await Deno.writeTextFile(artifact, "installer bytes")
    await rejects(verifyWindDownload(scratch.path), /missing entry/)
    const line = `${await blake3Hash(artifact)}  ${name}\n`
    await Deno.writeTextFile(sums, line)
    strictEqual(await verifyWindDownload(scratch.path), artifact)
    await Deno.writeTextFile(sums, line + line)
    await rejects(verifyWindDownload(scratch.path), /checksum mismatch/)
    await Deno.writeTextFile(sums, line)
    await Deno.writeTextFile(artifact, "tampered bytes")
    await rejects(verifyWindDownload(scratch.path), /checksum mismatch/)
    await Deno.writeTextFile(
      path.join(scratch.path, name.replace("0.1.0", "0.2.0")),
      "ambiguous",
    )
    await rejects(verifyWindDownload(scratch.path), /found 2/)
  } finally {
    ok(
      path.isAbsolute(scratch.path) &&
        path.basename(scratch.path).startsWith("keyboard-wind-test-"),
    )
    await Deno.remove(scratch.path, { recursive: true })
  }
})

Deno.test("keyboard manifest installs the embedded Wind setup and leaves the shared product on removal", () => {
  const builder = new OuttoBuilder(".", "windows").id("keyboard-test").name(
    "Keyboard test",
  ).version("0.1.0").defaultDir("#{pf}/Keyboard test")
  addWindToOutto(builder)
  const manifest = toml.parse(builder.build())
  const files = manifest.files as Array<{ source: string; dest: string }>
  strictEqual(files.length, 2)
  ok(files.every((file) => file.dest === "#{app}/dependencies/divvun-wind"))
  ok(files.some((file) => file.source.endsWith("/divvun-wind-installer.exe")))
  const runs = manifest.run as Array<
    { phase: string; command: string; arguments: string; wait: boolean }
  >
  strictEqual(runs.length, 1)
  strictEqual(runs[0].phase, "after_install")
  strictEqual(runs[0].wait, true)
  ok(
    runs[0].arguments.includes(
      '"#{app}/dependencies/divvun-wind/install-wind.ps1"',
    ),
  )
  strictEqual(manifest.registry, undefined)
  strictEqual(manifest.uninstall, undefined)
})

// Exercise the actual PowerShell entrypoint with OS/process probes replaced.
// This never launches an installer or modifies the host's registry.
Deno.test({
  name:
    "Wind install hook skips unsupported hosts, quotes spaced paths and preserves exit codes",
  ignore: Deno.build.os !== "windows",
  fn: async () => {
    using scratch = await makeTempDir({ prefix: "keyboard-wind-hook-test-" })
    try {
      const stage = path.join(scratch.path, "setup path with spaces")
      await Deno.mkdir(stage)
      const script = path.join(stage, "install-wind.ps1")
      await Deno.copyFile(
        new URL("./install-wind.ps1", import.meta.url),
        script,
      )
      const probe = path.join(scratch.path, "probe.ps1")
      await Deno.writeTextFile(
        probe,
        `
function Get-ItemProperty {
  param([string]$LiteralPath)
  if ($LiteralPath -like '*CurrentVersion') {
    return [pscustomobject]@{ CurrentMajorVersionNumber = 10; CurrentMinorVersionNumber = 0; CurrentBuildNumber = [int]$env:WIND_TEST_BUILD }
  }
  return [pscustomobject]@{ ProductType = $env:WIND_TEST_PRODUCT }
}
function Start-Process {
  param([string]$FilePath, [string[]]$ArgumentList, [switch]$Wait, [switch]$PassThru, [string]$WindowStyle)
  [pscustomobject]@{ FilePath = $FilePath; ArgumentList = $ArgumentList; Wait = [bool]$Wait; PassThru = [bool]$PassThru; WindowStyle = $WindowStyle } | ConvertTo-Json | Set-Content -LiteralPath $env:WIND_TEST_LOG
  return [pscustomobject]@{ ExitCode = [int]$env:WIND_TEST_EXIT }
}
$env:PROCESSOR_ARCHITECTURE = $env:WIND_TEST_ARCH
Remove-Item Env:PROCESSOR_ARCHITEW6432 -ErrorAction SilentlyContinue
& $env:WIND_TEST_SCRIPT
exit $LASTEXITCODE
`,
      )
      const log = path.join(scratch.path, "launch.json")
      const shell = path.join(
        Deno.env.get("SystemRoot")!,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      )
      for (
        const [arch, build, product, exit, launched] of [
          ["x86", 19045, "WinNT", 0, false],
          ["ARM64", 26100, "WinNT", 0, false],
          ["AMD64", 19045, "WinNT", 0, false],
          ["AMD64", 26100, "ServerNT", 0, false],
          ["AMD64", 26100, "WinNT", 0, true],
          ["AMD64", 26100, "WinNT", 27, true],
          ["AMD64", 26100, "WinNT", 3010, true],
        ] as const
      ) {
        const result = await new Deno.Command(shell, {
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            probe,
          ],
          env: {
            WIND_TEST_ARCH: arch,
            WIND_TEST_BUILD: String(build),
            WIND_TEST_PRODUCT: product,
            WIND_TEST_EXIT: String(exit),
            WIND_TEST_LOG: log,
            WIND_TEST_SCRIPT: script,
          },
          stdout: "piped",
          stderr: "piped",
        }).output()
        strictEqual(result.code, exit, new TextDecoder().decode(result.stderr))
        if (launched) {
          ok(
            await Deno.stat(log).then(() => true, () => false),
            new TextDecoder().decode(result.stderr),
          )
          const record = JSON.parse(await Deno.readTextFile(log))
          strictEqual(
            record.FilePath,
            path.join(stage, "divvun-wind-installer.exe"),
          )
          deepStrictEqual(record.ArgumentList, [
            "/VERYSILENT",
            "/SUPPRESSMSGBOXES",
            "/NORESTART",
            "/SP-",
          ])
          strictEqual(record.Wait, true)
          strictEqual(record.PassThru, true)
          strictEqual(record.WindowStyle, "Hidden")
          await Deno.remove(log)
        } else {
          await rejects(Deno.stat(log), Deno.errors.NotFound)
        }
      }
    } finally {
      ok(
        path.isAbsolute(scratch.path) &&
          path.basename(scratch.path).startsWith("keyboard-wind-hook-test-"),
      )
      await Deno.remove(scratch.path, { recursive: true })
    }
  },
})
