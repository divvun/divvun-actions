import { equal, match, throws } from "node:assert/strict"
import logger, { LogLevel } from "~/util/log.ts"

const LOG_MODULE = new URL("./log.ts", import.meta.url).href

/**
 * The level util/log.ts starts at with this LOG_LEVEL, loaded in a fresh
 * process because it reads LOG_LEVEL only once, when it first loads.
 */
async function initialLevel(value: string) {
  const { stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      `const { default: logger } = await import(${
        JSON.stringify(LOG_MODULE)
      }); console.log(logger.logLevel)`,
    ],
    env: { LOG_LEVEL: value },
  }).output()
  const decoder = new TextDecoder()
  return {
    level: Number(decoder.decode(stdout).trim()),
    stderr: decoder.decode(stderr),
  }
}

Deno.test("LOG_LEVEL sets the level the logger starts at, in any case", async () => {
  equal((await initialLevel("debug")).level, LogLevel.Debug)
  equal((await initialLevel("DEBUG")).level, LogLevel.Debug)
  equal((await initialLevel("warn")).level, LogLevel.Warning)
  equal((await initialLevel("")).level, LogLevel.Info)
})

Deno.test("an unknown LOG_LEVEL is ignored with a warning", async () => {
  const { level, stderr } = await initialLevel("verbose")
  equal(level, LogLevel.Info)
  match(stderr, /Ignoring LOG_LEVEL=verbose/)
})

Deno.test("setLogLevel takes a level's name in any case", () => {
  const before = logger.logLevel
  try {
    logger.setLogLevel("Trace")
    equal(logger.logLevel, LogLevel.Trace)
    throws(() => logger.setLogLevel("verbose"), /Invalid log level/)
  } finally {
    logger.setLogLevel(before)
  }
})
