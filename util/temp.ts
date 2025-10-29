const originalMakeTempFile = Deno.makeTempFile
const originalMakeTempDir = Deno.makeTempDir
const originalMakeTempFileSync = Deno.makeTempFileSync
const originalMakeTempDirSync = Deno.makeTempDirSync

export class DisposablePath {
  #isDisposed: boolean = false
  readonly path: string

  constructor(tempPath: string) {
    this.path = tempPath
  }

  [Symbol.dispose]() {
    if (this.#isDisposed) {
      Deno.removeSync(this.toString(), { recursive: true })
      this.#isDisposed = true
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#isDisposed) {
      await Deno.remove(this.toString(), { recursive: true })
      this.#isDisposed = true
    }
  }

  get [Symbol.toStringTag]() {
    return "DisposablePath"
  }
}

function assignDispose(dir: string) {
  return new DisposablePath(dir)
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

Deno.makeTempDir = (): never => {
  throw new Error("Use util/temp.ts to create temporary directories")
}

Deno.makeTempDirSync = (): never => {
  throw new Error("Use util/temp.ts to create temporary directories")
}

Deno.makeTempFile = (): never => {
  throw new Error("Use util/temp.ts to create temporary files")
}

Deno.makeTempFileSync = (): never => {
  throw new Error("Use util/temp.ts to create temporary files")
}
