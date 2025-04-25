import * as path from "@std/path"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"
import { Bash } from "~/util/shared.ts"

export default async function langCheck() {
  const githubWorkspace = builder.env.workspace
  if (githubWorkspace == null) {
    logger.error("GITHUB_WORKSPACE not set, failing.")
    Deno.exit(1)
  }
  const directory = path.join(githubWorkspace, "lang")
  await Bash.runScript(
    "make check -j$(nproc) || cat tools/spellcheckers/test/fstbased/desktop/hfst/test-suite.log",
    { cwd: path.join(directory, "build") },
  )
}

// async function run() {
//   await langCheck()
// }
