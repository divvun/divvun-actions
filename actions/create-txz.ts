import * as fs from "@std/fs"
import * as path from "@std/path"
import logger from "~/util/log.ts"
import { Tar } from "~/util/shared.ts"
import { makeTempFile } from "../util/temp.ts"

export type Props = {
  filesPath: string
}

export type Output = {
  txzPath: string
}

export default async function createTxz({ filesPath }: Props): Promise<Output> {
  logger.info("Files path: " + filesPath)
  const files = await fs.expandGlob(path.join(filesPath, "*"), {
    followSymlinks: false,
    includeDirs: true,
  })

  const outputTxz = await makeTempFile({
    suffix: ".txz",
  })

  const input = []
  for await (const file of files) {
    input.push(file.path)
  }
  logger.info(input)

  await Tar.createFlatTxz(input, outputTxz.path)
  return { txzPath: outputTxz.path }
}
