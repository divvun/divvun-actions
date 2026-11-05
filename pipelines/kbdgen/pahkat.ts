// kbdgen's main builds as dev releases of main/kbdgen: a .pkt.box for each
// target, holding the kbdgen binary that target ships, as the old Pahkat's
// devtools deploy (actions/kbdgen/deploy.ts) ships it in a tarball.

import * as path from "@std/path"
import * as toml from "@std/toml"
import * as builder from "~/builder.ts"
import {
  type Arch,
  type Artifact,
  type Os,
  publishRelease,
  repositoryLicense,
} from "~/util/pahkat.ts"
import { createPktBox } from "~/util/pkt_box.ts"
import { versionAsNightly } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"
import { kbdgenPath, platforms } from "./mod.ts"

const PACKAGE = "kbdgen"

/**
 * The GitHub release the attestation names. kbdgen's main builds are
 * published under none, so this names the rolling prerelease other tools'
 * main builds have, which kbdgen does not have.
 */
const DEV_TAG = "dev-latest"

/**
 * Publish this build's kbdgen for every target as one release, versioned as
 * the old devtools deploy versions it.
 */
export async function runKbdgenPahkatPublish() {
  const cargo = toml.parse(await Deno.readTextFile("Cargo.toml")) as {
    package: { version: string }
  }
  const version = await versionAsNightly(
    cargo.package.version,
    builder.env.buildNumber,
  )

  using dir = await makeTempDir({ prefix: "pahkat-kbdgen-" })
  const artifacts: Artifact[] = []
  for (const [os, targets] of Object.entries(platforms)) {
    for (const target of targets) {
      const built = kbdgenPath(os, target)
      const shipped = os === "linux" ? built : `signed/${built}`
      await builder.downloadArtifacts(shipped, dir.path)
      const binary = path.join(dir.path, shipped)
      if (os !== "windows") await Deno.chmod(binary, 0o755)

      const arch = target.split("-", 1)[0] as Arch
      const box = path.join(
        dir.path,
        `${PACKAGE}_${version}_${os}_${arch}.pkt.box`,
      )
      await createPktBox(box, {
        pkg: PACKAGE,
        version,
        files: [{ path: binary }],
      })
      artifacts.push({ path: box, kind: "box", os: [os as Os], arch: [arch] })
    }
  }

  await publishRelease({
    package: PACKAGE,
    version,
    tag: DEV_TAG,
    metadata: {
      names: { en: "kbdgen" },
      authors: ["Divvun"],
      ...await repositoryLicense(),
      tags: ["cat:ci"],
    },
    artifacts,
  })
}
