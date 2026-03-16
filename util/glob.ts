import * as fs from "@std/fs"

/** Find the first file matching a glob pattern, or null if none found. */
export async function globOneFile(
  pattern: string,
  options?: { root?: string },
): Promise<string | null> {
  const files = await fs.expandGlob(pattern, { root: options?.root })
  for await (const file of files) {
    if (file.isFile) {
      return file.path
    }
  }
  return null
}

/** Find the first directory matching a glob pattern, or null if none found. */
export async function globOneDir(
  pattern: string,
  options?: { root?: string },
): Promise<string | null> {
  const entries = await fs.expandGlob(pattern, { root: options?.root })
  for await (const entry of entries) {
    if (entry.isDirectory) {
      return entry.path
    }
  }
  return null
}

/** Find all files matching a glob pattern. */
export async function globFiles(
  pattern: string,
  options?: { root?: string },
): Promise<string[]> {
  const files = await fs.expandGlob(pattern, { root: options?.root })
  const result: string[] = []
  for await (const file of files) {
    if (file.isFile) {
      result.push(file.path)
    }
  }
  return result
}
