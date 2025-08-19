
const originalMakeTempFile = Deno.makeTempFile
const originalMakeTempDir = Deno.makeTempDir
const originalMakeTempFileSync = Deno.makeTempFileSync
const originalMakeTempDirSync = Deno.makeTempDirSync

const isDisposedSymbol = Symbol("isDisposed")

export type DisposablePath = string & {
  [Symbol.asyncDispose](): Promise<void>
  [Symbol.dispose](): void
  [isDisposedSymbol]?: boolean
}

function assignDispose(dir: string) {
  const tempDir = new String(dir) as string & {
    [isDisposedSymbol]?: boolean
  }

  Object.defineProperties(tempDir, {
    [Symbol.dispose]: {
      value: () => {
        if (!tempDir[isDisposedSymbol]) {
          Deno.removeSync(tempDir as string, { recursive: true })
          tempDir[isDisposedSymbol] = true
        }
      },
    },
    [Symbol.asyncDispose]: {
      value: async () => {
        if (!tempDir[isDisposedSymbol]) {
          await Deno.remove(tempDir as string, { recursive: true })
          tempDir[isDisposedSymbol] = true
        }
      },
    },
  })

  return tempDir as DisposablePath
}

export async function makeTempFile(
  options: Deno.MakeTempOptions = {},
): Promise<DisposablePath> {
  return assignDispose(await originalMakeTempFile(options))
}

export function makeTempFileSync(
  options: Deno.MakeTempOptions = {},
): DisposablePath {
  return assignDispose(originalMakeTempFileSync(options))
}

export async function makeTempDir(
  options: Deno.MakeTempOptions = {},
): Promise<DisposablePath> {
  return assignDispose(await originalMakeTempDir(options))
}

export function makeTempDirSync(
  options: Deno.MakeTempOptions = {},
): DisposablePath {
  return assignDispose(originalMakeTempDirSync(options))
}

Deno.makeTempDir = (): Promise<string> => {
  throw new Error("Use util/temp.ts to create temporary directories")
}

Deno.makeTempDirSync = (): string => {
  throw new Error("Use util/temp.ts to create temporary directories")
}

Deno.makeTempFile = (): Promise<string> => {
  throw new Error("Use util/temp.ts to create temporary files")
}

Deno.makeTempFileSync = (): string => {
  throw new Error("Use util/temp.ts to create temporary files")
}
