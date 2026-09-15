import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict"
import { type CommandStep, validatePipeline } from "~/builder/pipeline.ts"
import * as path from "@std/path"
import * as toml from "@std/toml"
import { assetTarget } from "~/util/asset_name.ts"
import { makeTempDir } from "~/util/temp.ts"

Deno.env.set("BUILDKITE", "true")
Deno.env.set("BUILDKITE_REPO", "git@github.com:divvun/msgrammar.git")
Deno.env.delete("BUILDKITE_PLUGINS")
const {
  MSGRAMMAR_PAYLOADS,
  MSGRAMMAR_TARGET,
  msgrammarManifest,
  sha256,
  verifyMsgrammarBuild,
} = await import("~/actions/msgrammar/bundle.ts")
const builder = await import("~/builder.ts")
const { createCiPipeline } = await import("~/cli.ts")
const target = await import("~/target.ts")
const {
  msgrammarReleaseMode,
  msgrammarVersion,
  runMsgrammarPublish,
  verifyMsgrammarInstaller,
} = await import("~/pipelines/msgrammar.ts")

Deno.test("msgrammar packages after checks and publishes only trusted main/version builds", async () => {
  for (
    const [branch, tag, pullRequest, mode] of [
      ["main", undefined, "false", "dev"],
      ["feature", undefined, "false", null],
      ["feature", undefined, "42", null],
      ["main", "v0.1.0", "false", "release"],
      ["main", "v0.1.0-beta.1", "false", "release"],
      ["main", undefined, "42", null],
      ["main", "v0.1.0", "42", null],
      ["main", "dev-latest", "false", null],
      ["main", "v01.2.3", "false", null],
      ["main", "vgarbage", "false", null],
    ] as const
  ) {
    builder.env.branch = branch
    builder.env.tag = tag
    builder.env.pullRequest = pullRequest
    const pipeline = await createCiPipeline()
    validatePipeline(pipeline)
    strictEqual(msgrammarReleaseMode(), mode)
    strictEqual(pipeline.steps.length, mode ? 3 : 2)
    const step = pipeline.steps[0] as CommandStep
    strictEqual(step.key, "check-build-x86_64-pc-windows-msvc")
    strictEqual(step.command, "pwsh -NoProfile -File scripts/buildkite.ps1")
    deepStrictEqual(step.agents, { queue: "windows" })
    deepStrictEqual(step.plugins, [
      `ssh://git@github.com/divvun/divvun-actions.git#${target.gitHash}`,
    ])
    strictEqual(step.timeout_in_minutes, 45)
    ok(!step.soft_fail)
    ok(!step.allow_dependency_failure)
    ok(!step.skip)
    const installer = pipeline.steps[1] as CommandStep
    strictEqual(installer.depends_on, step.key)
    strictEqual(installer.command, "divvun-actions run msgrammar-installer")
    deepStrictEqual(installer.agents, { queue: "windows" })
    if (mode) {
      const publish = pipeline.steps[2] as CommandStep
      deepStrictEqual(publish.depends_on, [step.key, installer.key])
      strictEqual(publish.command, "divvun-actions run msgrammar-publish")
      deepStrictEqual(publish.agents, { queue: "linux" })
      strictEqual(publish.concurrency, 1)
    }
    for (const command of pipeline.steps as CommandStep[]) {
      deepStrictEqual(command.plugins, [
        `ssh://git@github.com/divvun/divvun-actions.git#${target.gitHash}`,
      ])
      ok(!command.soft_fail && !command.allow_dependency_failure)
    }
  }
})

Deno.test("msgrammar outto installs the payload and invokes per-user registration", () => {
  const manifest = toml.parse(msgrammarManifest(".", "0.1.0"))
  const pkg = manifest.package as Record<string, unknown>
  strictEqual(pkg.id, "no.divvun.msgrammar")
  strictEqual(pkg.architecture, "x64")
  strictEqual(pkg.privileges, "user")
  strictEqual(pkg.default_dir, "#{localappdata}/Divvun/WordAddin/setup")
  deepStrictEqual(manifest.reboot, { restart_manager: false })
  const files = (manifest.files as Array<{ source: string }>).map((file) =>
    file.source
  )
  deepStrictEqual(files, [
    ...MSGRAMMAR_PAYLOADS,
    "Install-WordAddin.ps1",
    "Register-WordAddin.ps1",
    "New-WordAddinPackage.ps1",
    "INSTALL.md",
  ])
  deepStrictEqual(manifest.run, [{
    phase: "after_install",
    command: "#{sys}/WindowsPowerShell/v1.0/powershell.exe",
    arguments:
      '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "#{app}/Install-WordAddin.ps1"',
    wait: true,
    show: "hidden",
  }])
  strictEqual(manifest.registry, undefined)
})

Deno.test("msgrammar rejects failed checks, mixed builds and modified payloads before signing", async () => {
  const dir = (await makeTempDir()).path
  try {
    const record = {
      version: 1,
      commit: "a".repeat(40),
      target: MSGRAMMAR_TARGET,
      signed: false,
      checks: ["format", "lint", "test", "powershell", "release-build"],
      files: [] as Array<{ path: string; bytes: number; sha256: string }>,
    }
    for (const name of MSGRAMMAR_PAYLOADS) {
      const file = path.join(dir, name)
      await Deno.writeTextFile(file, "test payload")
      record.files.push({
        path: `target/${MSGRAMMAR_TARGET}/release/${name}`,
        bytes: (await Deno.stat(file)).size,
        sha256: await sha256(file),
      })
    }
    const save = () =>
      Deno.writeTextFile(
        path.join(dir, "msgrammar-build.json"),
        JSON.stringify(record),
      )
    await save()
    await verifyMsgrammarBuild(dir, record.commit)
    await rejects(verifyMsgrammarBuild(dir, "b".repeat(40)), /provenance/)
    record.checks.pop()
    await save()
    await rejects(verifyMsgrammarBuild(dir, record.commit), /provenance/)
    record.checks.push("release-build")
    await save()
    await Deno.writeTextFile(
      path.join(dir, MSGRAMMAR_PAYLOADS[0]),
      "modified payload",
    )
    await rejects(
      verifyMsgrammarBuild(dir, record.commit),
      /artifact does not match/,
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("msgrammar publication rejects PRs before accessing credentials and checks version and artifact identity", async () => {
  builder.env.branch = "main"
  builder.env.tag = undefined
  builder.env.pullRequest = "42"
  await rejects(runMsgrammarPublish(), /outside a pull request/)
  builder.env.pullRequest = "false"
  builder.env.commit = "a".repeat(40)
  const dir = (await makeTempDir()).path
  const cwd = Deno.cwd()
  try {
    await Deno.writeTextFile(
      path.join(dir, "Cargo.toml"),
      '[workspace.package]\nversion = "0.1.0"\n',
    )
    Deno.chdir(dir)
    builder.env.tag = "v0.1.0"
    strictEqual(await msgrammarVersion(), "0.1.0")
    builder.env.tag = "v0.2.0"
    await rejects(msgrammarVersion(), /does not match Cargo version/)
    const installer = `msgrammar_${assetTarget(MSGRAMMAR_TARGET)}.exe`
    const manifest = installer.replace(".exe", ".outto.toml")
    await Deno.writeTextFile(installer, "installer")
    await Deno.writeTextFile(manifest, "manifest")
    const record = {
      signed: true,
      version: "0.1.0",
      commit: builder.env.commit,
      target: MSGRAMMAR_TARGET,
      installer_sha256: await sha256(installer),
      manifest_sha256: await sha256(manifest),
    }
    await Deno.writeTextFile(
      installer.replace(".exe", ".build.json"),
      JSON.stringify(record),
    )
    await verifyMsgrammarInstaller(dir, "0.1.0")
    await rejects(verifyMsgrammarInstaller(dir, "0.2.0"), /provenance/)
    builder.env.commit = "b".repeat(40)
    await rejects(verifyMsgrammarInstaller(dir, "0.1.0"), /provenance/)
    builder.env.commit = record.commit
    await Deno.writeTextFile(installer, "tampered installer")
    await rejects(verifyMsgrammarInstaller(dir, "0.1.0"), /checksum/)
  } finally {
    Deno.chdir(cwd)
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("msgrammar registration keeps unknown repositories rejected", async () => {
  builder.env.repoName = "unrecognized-msgrammar-repo"
  try {
    await rejects(
      createCiPipeline(),
      /Unknown repo: unrecognized-msgrammar-repo/,
    )
  } finally {
    builder.env.repoName = "msgrammar"
  }
})
