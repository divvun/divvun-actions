import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict"
import * as toml from "@std/toml"
import { validatePipeline } from "~/builder/pipeline.ts"
import type { CommandStep } from "~/builder/pipeline.ts"

Deno.env.set("BUILDKITE", "true")
Deno.env.set("BUILDKITE_REPO", "git@github.com:divvun/divvun-wind.git")
Deno.env.delete("BUILDKITE_PLUGINS")
const builder = await import("~/builder.ts")
const { createCiPipeline } = await import("~/cli.ts")
const { windReleaseMode, runWindPublish } = await import(
  "~/pipelines/divvun-wind.ts"
)
const { windManifest } = await import("~/actions/divvun-wind/bundle.ts")
const target = await import("~/target.ts")

Deno.test("Wind installer depends on checks; publication only follows trusted main/version builds", async () => {
  for (
    const [branch, tag, pullRequest, mode] of [
      ["main", undefined, "false", "dev"],
      ["feature", undefined, "false", null],
      ["main", "v0.1.0", "false", "release"],
      ["main", undefined, "42", null],
      ["main", "dev-latest", "false", null],
      ["main", "arbitrary-tag", "false", null],
    ] as const
  ) {
    builder.env.branch = branch
    builder.env.tag = tag
    builder.env.pullRequest = pullRequest
    strictEqual(windReleaseMode(), mode)
    const pipeline = await createCiPipeline()
    validatePipeline(pipeline)
    strictEqual(pipeline.steps.length, mode ? 3 : 2)
    const [build, installer, publish] = pipeline.steps as CommandStep[]
    strictEqual(build.command, "pwsh -NoProfile -File scripts/buildkite.ps1")
    deepStrictEqual(build.agents, { queue: "windows" })
    strictEqual(installer.depends_on, build.key)
    strictEqual(installer.command, "divvun-actions run divvun-wind-installer")
    if (mode) {
      deepStrictEqual(publish.depends_on, [build.key, installer.key])
      strictEqual(publish.command, "divvun-actions run divvun-wind-publish")
      strictEqual(publish.concurrency, 1)
    }
    for (const step of pipeline.steps as CommandStep[]) {
      deepStrictEqual(step.plugins, [
        `ssh://git@github.com/divvun/divvun-actions.git#${target.gitHash}`,
      ])
      ok(!step.allow_dependency_failure)
      ok(!step.soft_fail)
    }
  }
})

Deno.test("Wind manifest owns only its startup value and versioned payload; preserves keyboard data", () => {
  const manifest = toml.parse(windManifest(".", {
    id: "no.divvun.wind",
    name: "Divvun Windows Daemon",
    publisher: "Divvun",
    default_dir: "#{pf}/Divvun/Wind",
    catalogue_dir: "#{commonappdata}/Divvun/Keyboards",
    payloads: ["divvun-wind.exe", "divvun-wind-symbols.exe", "divvunwind.dll"],
    debugger_packages: ["dbghelp.dll", "msdia140.dll", "symsrv.dll"].map((
      filename,
    ) => ({
      id: filename,
      version: "test",
      url: "https://example.invalid",
      sha256: "test",
      files: [{ member: filename, filename }],
    })),
  }, "0.1.0-dev.20260915T120000Z+build.3"))
  const pkg = manifest.package as Record<string, unknown>
  strictEqual(pkg.architecture, "x64")
  strictEqual(
    pkg.default_dir,
    "#{pf}/Divvun/Wind/versions/0.1.0-dev.20260915T120000Z+build.3",
  )
  deepStrictEqual(manifest.reboot, { restart_manager: false })
  deepStrictEqual(manifest.dirs, [{
    path: "#{commonappdata}/Divvun/Keyboards",
    preserve_on_uninstall: true,
  }])
  deepStrictEqual(manifest.registry, [{
    root: "hklm",
    key: "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    values: [{
      name: "DivvunWind",
      type: "string",
      data: '"#{app}/divvun-wind.exe" run',
    }],
    uninstall: "remove_values",
  }])
  const files = manifest.files as Array<{ source: string }>
  deepStrictEqual(files.map((f) => f.source), [
    "divvun-wind.exe",
    "divvun-wind-symbols.exe",
    "divvunwind.dll",
    "dbghelp.dll",
    "msdia140.dll",
    "symsrv.dll",
    "LICENSE-MIT",
    "LICENSE-APACHE",
    "THIRD-PARTY-NOTICES.md",
  ])
  strictEqual(manifest.run, undefined)
})

Deno.test("Wind publish refuses pull requests before accessing artifacts or credentials", async () => {
  builder.env.branch = "main"
  builder.env.tag = undefined
  builder.env.pullRequest = "42"
  await rejects(runWindPublish(), /requires main or a version tag/)
  builder.env.pullRequest = "false"
})

Deno.test("CI dispatch still rejects unrecognized repository names", async () => {
  builder.env.repoName = "unrecognized-wind-repo"
  try {
    await rejects(createCiPipeline(), /Unknown repo: unrecognized-wind-repo/)
  } finally {
    builder.env.repoName = "divvun-wind"
  }
})
