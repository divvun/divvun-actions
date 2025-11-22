export interface ExecOptions {
  cwd?: string
  env?: Record<string, string>
  input?: string
  silent?: boolean
  ignoreReturnCode?: boolean
  listeners?: {
    stdout?: (chunk: Uint8Array) => void
    stderr?: (chunk: Uint8Array) => void
  }
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export async function spawn(
  commandLine: string,
  args?: string[],
  options?: ExecOptions,
): Promise<Deno.ChildProcess> {
  const stdio: "inherit" | "piped" | "null" =
    options?.listeners?.stdout || options?.listeners?.stderr
      ? "piped"
      : options?.silent
      ? "null"
      : "inherit"

  const command = new Deno.Command(commandLine, {
    args: args || [],
    cwd: options?.cwd,
    env: options?.env,
    stdin: options?.input ? "piped" : "inherit",
    stdout: stdio,
    stderr: stdio,
  })

  const process = command.spawn()

  if (options?.input != null) {
    const writer = process.stdin.getWriter()
    await writer.write(encoder.encode(options.input))
    await writer.close()
  }

  if (options?.listeners?.stdout && process.stdout) {
    ;(async () => {
      for await (const chunk of process.stdout) {
        options?.listeners?.stdout?.(chunk)
      }
    })()
  }

  if (options?.listeners?.stderr && process.stderr) {
    ;(async () => {
      for await (const chunk of process.stderr) {
        options?.listeners?.stderr?.(chunk)
      }
    })()
  }

  return process
}

export async function exec(
  commandLine: string,
  args?: string[],
  options?: ExecOptions,
): Promise<number> {
  const proc = await spawn(commandLine, args, options)
  const status = await proc.status

  if (status.code !== 0 && !options?.ignoreReturnCode) {
    throw new Error(`Process exited with code ${status.code}`)
  }

  return status.code
}

export async function output(
  commandLine: string,
  args?: string[],
  options?: Omit<ExecOptions, "silent" | "listeners">,
): Promise<{ stdout: string; stderr: string; status: Deno.CommandStatus }> {
  const proc = await new Deno.Command(commandLine, {
    args: args || [],
    cwd: options?.cwd,
    env: options?.env,
    stdin: options?.input ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn()

  if (options?.input) {
    ;(async () => {
      const writer = proc.stdin.getWriter()
      await writer.write(encoder.encode(options.input!))
      await writer.close()
    })()
  }

  const result = await proc.output()

  return {
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
    status: {
      code: result.code,
      success: result.success,
      signal: result.signal,
    },
  }
}
