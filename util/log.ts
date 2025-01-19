// deno-lint-ignore-file no-console

export enum LogLevel {
  Trace,
  Debug,
  Info,
  Warning,
  Error,
}

let logLevel: LogLevel = LogLevel.Info

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
      switch (level) {
        case "trace":
          level = LogLevel.Trace
          break
        case "debug":
          level = LogLevel.Debug
          break
        case "info":
          level = LogLevel.Info
          break
        case "warning":
          level = LogLevel.Warning
          break
        case "error":
          level = LogLevel.Error
          break
        default:
          throw new Error(`Invalid log level: ${level}`)
      }
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
