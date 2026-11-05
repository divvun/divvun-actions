// A step that makes the old pahkat.uit.no artifacts and Pahkat-next ones in
// one go uploads the old ones first. If the new ones then fail, the step
// throws SoftFailure, main.ts exits with SOFT_FAIL_EXIT_STATUS, and the step,
// declared with `soft_fail: [{ exit_status: SOFT_FAIL_EXIT_STATUS }]`, soft
// fails: the old deploy, which depends on it, still runs.

export const SOFT_FAIL_EXIT_STATUS = 75

export class SoftFailure extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = "SoftFailure"
  }
}
