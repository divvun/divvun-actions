import * as path from "@std/path"
import { stripAnsiCode } from "@std/fmt/colors"
import * as builder from "~/builder.ts"
import { makeTempDir } from "~/util/temp.ts"
import { restoreBuiltWorkspace } from "./common.ts"
import {
  spellerProofingMakeSteps,
  stageSpellerProofing,
} from "../proofing/speller.ts"

async function run(command: string, args: string[], cwd: string) {
  const status = await new Deno.Command(command, {
    args,
    cwd,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status
  if (!status.success) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${status.code}`,
    )
  }
}

/** Build a spelling-only DRB from the speller workspace, keeping grammar off. */
export default async function langProofingBuild(
  info: { name: string; version: string; locales?: string[] },
) {
  await restoreBuiltWorkspace("speller-configure-flags")
  const buildDir = path.resolve("build")
  for (const [directory, ...targets] of spellerProofingMakeSteps) {
    await run("make", ["-j2", ...targets], path.join(buildDir, directory))
  }

  using stage = await makeTempDir({ prefix: "proofing-speller-" })
  await stageSpellerProofing(buildDir, stage.path)
  const bundleArgs = [
    "bundle",
    "--type",
    "spellcheck",
    "--name",
    info.name,
    "--vers",
    info.version,
  ]
  // Omitted rather than passed empty, so a language that declares no regional
  // variants leaves the attribute absent instead of asserting it has none.
  if (info.locales?.length) {
    bundleArgs.push("--locales", info.locales.join(","))
  }
  await run("divvun-runtime", bundleArgs, stage.path)
  // Load and run the default pipeline before uploading: catches invalid models
  // and missing assets at the producer, before the three OS packaging jobs.
  const smoke = await new Deno.Command("divvun-runtime", {
    args: ["run", "--path", "bundle.drb"],
    cwd: stage.path,
    stdin: "null",
    stdout: "piped",
    stderr: "inherit",
  }).output()
  if (!smoke.success) {
    throw new Error("Spelling proofing pipeline failed to load")
  }
  // Runtime versions may exit successfully without an output on a pipeline
  // error, so check the actual result as well as the exit status.
  const result = JSON.parse(
    stripAnsiCode(new TextDecoder().decode(smoke.stdout)),
  )
  if (
    result.text !== "" || !Array.isArray(result.errors) ||
    result.errors.length !== 0
  ) {
    throw new Error(
      "Spelling proofing pipeline did not return an empty GrammarOutput",
    )
  }

  const output = path.join(buildDir, "tools", "proofing", "bundle.drb")
  await Deno.mkdir(path.dirname(output), { recursive: true })
  await Deno.copyFile(path.join(stage.path, "bundle.drb"), output)
  await builder.uploadArtifacts("build/tools/proofing/bundle.drb")
}
