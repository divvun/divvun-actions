// deno-lint-ignore-file no-console

export enum LogLevel {
  Trace,
  Debug,
  Info,
  Warning,
  Error,
}

const LOG_LEVELS = new Map([
  ["trace", LogLevel.Trace],
  ["debug", LogLevel.Debug],
  ["info", LogLevel.Info],
  ["warn", LogLevel.Warning],
  ["warning", LogLevel.Warning],
  ["error", LogLevel.Error],
])

function parseLogLevel(name: string): LogLevel | undefined {
  return LOG_LEVELS.get(name.toLowerCase())
}

/**
 * The level LOG_LEVEL names, read when this module loads so that it covers
 * the first line logged. A name it does not know leaves the level at info
 * rather than failing the build.
 */
function initialLogLevel(): LogLevel {
  const permission = Deno.permissions.querySync({
    name: "env",
    variable: "LOG_LEVEL",
  })
  const name = permission.state === "granted"
    ? Deno.env.get("LOG_LEVEL")
    : undefined
  if (!name) return LogLevel.Info
  const level = parseLogLevel(name)
  if (level == null) {
    console.warn(
      `Ignoring LOG_LEVEL=${name}: expected trace, debug, info, warn or error`,
    )
    return LogLevel.Info
  }
  return level
}

let logLevel: LogLevel = initialLogLevel()

export type Logger = {
  setLogLevel(level: LogLevel | string): void
  get logLevel(): LogLevel

  trace(...data: any[]): void
  debug(...data: any[]): void
  info(...data: any[]): void
  warning(...data: any[]): void
  error(...data: any[]): void
}

const logger: Logger = {
  get logLevel() {
    return logLevel
  },
  setLogLevel(level: LogLevel | string) {
    if (typeof level === "string") {
      const parsed = parseLogLevel(level)
      if (parsed == null) throw new Error(`Invalid log level: ${level}`)
      level = parsed
    }
    logLevel = level
  },
  trace(...data: any[]) {
    if (logLevel > LogLevel.Trace) {
      return
    }
    console.trace(...data)
  },
  debug(...data: any[]) {
    if (logLevel > LogLevel.Debug) {
      return
    }
    console.debug(...data)
  },
  info(...data: any[]) {
    if (logLevel > LogLevel.Info) {
      return
    }
    console.info(...data)
  },
  warning(...data: any[]) {
    if (logLevel > LogLevel.Warning) {
      return
    }
    console.warn(...data)
  },
  error(...data: any[]) {
    if (logLevel > LogLevel.Error) {
      return
    }
    console.error(...data)
  },
}

export default logger
