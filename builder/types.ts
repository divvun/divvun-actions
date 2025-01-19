export type ExecListeners = {
  /** A call back for each buffer of stdout */
  stdout?: (data: Uint8Array) => void
  /** A call back for each buffer of stderr */
  stderr?: (data: Uint8Array) => void
  /** A call back for each line of stdout */
  stdline?: (data: string) => void
  /** A call back for each line of stderr */
  errline?: (data: string) => void
  /** A call back for each debug log */
  debug?: (data: string) => void
}

export type ExecOptions = {
  /** optional working directory.  defaults to current */
  cwd?: string
  /** optional envvar dictionary.  defaults to current process's env */
  env?: {
    [key: string]: string
  }
  /** optional.  defaults to false */
  silent?: boolean
  /** optional. whether to skip quoting/escaping arguments if needed.  defaults to false. */
  windowsVerbatimArguments?: boolean
  /** optional.  whether to fail if output to stderr.  defaults to false */
  failOnStdErr?: boolean
  /** optional.  defaults to failing on non zero.  ignore will not fail leaving it up to the caller */
  ignoreReturnCode?: boolean
  /** optional. How long in ms to wait for STDIO streams to close after the exit event of the process before terminating. defaults to 10000 */
  delay?: number
  /** optional. input to write to the process on STDIN. */
  input?: string
  /** optional. Listeners for output. Callback functions that will be called on these events */
  listeners?: ExecListeners
}

export type InputOptions = {
  /** Optional. Whether the input is required. If required and not present, will throw. Defaults to false */
  required?: boolean
  /** Optional. Whether leading/trailing whitespace will be trimmed for the input. Defaults to true */
  trimWhitespace?: boolean
}

export type Context = {
  ref: string
  workspace: string
  repo: string
}
