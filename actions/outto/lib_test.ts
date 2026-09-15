import { ok, rejects, strictEqual } from "node:assert/strict"
import * as path from "@std/path"
import { makeTempDir } from "~/util/temp.ts"
import { makeOuttoInstaller, windowsOuttoSigning } from "./lib.ts"

// Integration test: invokes the installed outto CLI with a fake signer. No
// signing credentials, product installation, or release publication is involved.
Deno.test({
  name:
    "Windows outto passes spaced paths to the signer and propagates signing failure",
  ignore: Deno.build.os !== "windows",
  fn: async () => {
    using scratch = await makeTempDir({ prefix: "outto-signing-test-" })
    try {
      const sourceDir = path.join(scratch.path, "source with spaces")
      const signerDir = path.join(scratch.path, "signer with spaces")
      await Deno.mkdir(sourceDir)
      await Deno.mkdir(signerDir)
      await Deno.writeTextFile(
        path.join(sourceDir, "fixture.txt"),
        "Signing transport fixture only.\n",
      )
      const configPath = path.join(scratch.path, "outto.toml")
      await Deno.writeTextFile(
        configPath,
        `[package]
id = "no.divvun.outto.signing-test"
name = "Outto signing transport test"
version = "0.0.0"
default_dir = "#{pf}/Divvun/SigningTest"
architecture = "x64"
privileges = "admin"
[[files]]
source = "fixture.txt"
dest = "#{app}"
`,
      )
      const signer = path.join(signerDir, "sign.cmd")
      const log = path.join(scratch.path, "calls.txt")
      await Deno.writeTextFile(
        signer,
        `@echo off
if not "%~1"=="sign" exit /b 81
if not "%~3"=="" exit /b 82
if not exist "%~2" exit /b 83
>>"%DIVVUN_SIGN_TEST_LOG%" echo %~2
exit /b %DIVVUN_SIGN_TEST_EXIT%
`,
      )
      const signing = windowsOuttoSigning(signer)
      const outputPath = path.join(scratch.path, "output with spaces.exe")
      const options = {
        configPath,
        sourceDir,
        outputPath,
        target: "windows" as const,
        ...signing,
        env: {
          ...signing.env,
          DIVVUN_SIGN_TEST_LOG: log,
          DIVVUN_SIGN_TEST_EXIT: "0",
        },
      }
      await makeOuttoInstaller(options)
      const calls = (await Deno.readTextFile(log)).trim().split(/\r?\n/)
      strictEqual(calls.length, 2)
      strictEqual(path.basename(calls[0]), "outto-uninstall.exe")
      strictEqual(calls[1], outputPath)
      ok((await Deno.stat(outputPath)).size > 0)

      await Deno.writeTextFile(log, "")
      await rejects(
        makeOuttoInstaller({
          ...options,
          outputPath: path.join(scratch.path, "failed output.exe"),
          env: { ...options.env, DIVVUN_SIGN_TEST_EXIT: "27" },
        }),
        /outto build failed/,
      )
      const failedCalls = (await Deno.readTextFile(log)).trim().split(/\r?\n/)
      strictEqual(failedCalls.length, 3)
      ok(
        failedCalls.every((file) =>
          path.basename(file) === "outto-uninstall.exe"
        ),
      )
    } finally {
      // This tree is the unique directory created above and contains only test files.
      ok(
        path.isAbsolute(scratch.path) &&
          path.basename(scratch.path).startsWith("outto-signing-test-"),
      )
      await Deno.remove(scratch.path, { recursive: true })
    }
  },
})
