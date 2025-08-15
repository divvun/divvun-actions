export class ExpectedError extends Error {
  static create(message: string): ExpectedError
  static create(cause: Error, message?: string): ExpectedError
  static create(arg1: string | Error, message?: string): ExpectedError {
    if (typeof arg1 === "string") {
      return new ExpectedError(arg1)
    } else {
      return new ExpectedError(message, arg1)
    }
  }

  private constructor(message?: string, cause?: Error) {
    super(message, { cause })
    this.name = "ExpectedError"

    // Ensure proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, ExpectedError.prototype)

    // Capture stack trace, excluding constructor call from it
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ExpectedError)
    }
  }
}
