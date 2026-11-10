const decoder = new TextDecoder()

export class CommandError extends Error {
  constructor(
    readonly cmd: string,
    readonly args: string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(
      `${cmd} ${args.join(" ")} exited with ${code}${
        stderr ? `: ${stderr.trim()}` : ""
      }`,
    )
  }
}

export type RunOptions = {
  /** Exit codes other than 0 that still count as success. */
  okCodes?: number[]
  stdin?: string
}

export type RunResult = { code: number; stdout: string; stderr: string }

/** Run to completion, capturing output; throw on a failing exit code. */
export async function run(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const child = new Deno.Command(cmd, {
    args,
    stdin: opts.stdin != null ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn()
  if (opts.stdin != null) {
    const writer = child.stdin.getWriter()
    await writer.write(new TextEncoder().encode(opts.stdin))
    await writer.close()
  }
  const out = await child.output()
  const result = {
    code: out.code,
    stdout: decoder.decode(out.stdout),
    stderr: decoder.decode(out.stderr),
  }
  if (out.code !== 0 && !(opts.okCodes ?? []).includes(out.code)) {
    throw new CommandError(cmd, args, out.code, result.stderr)
  }
  return result
}

/** Whether the command exits 0. A missing binary counts as not. */
export async function succeeds(cmd: string, args: string[]): Promise<boolean> {
  try {
    const out = await new Deno.Command(cmd, {
      args,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output()
    return out.success
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false
    throw e
  }
}

/** `producer | consumer`, both run to completion; throws if either fails. */
export async function pipe(
  producer: { cmd: string; args: string[] },
  consumer: { cmd: string; args: string[] },
): Promise<void> {
  const p = new Deno.Command(producer.cmd, {
    args: producer.args,
    stdin: "null",
    stdout: "piped",
    stderr: "inherit",
  }).spawn()
  const c = new Deno.Command(consumer.cmd, {
    args: consumer.args,
    stdin: "piped",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn()
  const [, pStatus, cStatus] = await Promise.all([
    p.stdout.pipeTo(c.stdin).catch(() => {}),
    p.status,
    c.status,
  ])
  if (!pStatus.success) {
    throw new CommandError(producer.cmd, producer.args, pStatus.code, "")
  }
  if (!cStatus.success) {
    throw new CommandError(consumer.cmd, consumer.args, cStatus.code, "")
  }
}
