// deno-lint-ignore-file no-console
import { parseArgs } from "@std/cli/parse-args"
import * as path from "@std/path"
import logger from "~/util/log.ts"
import {
  ConfigError,
  DEFAULT_CONFIG_PATH,
  findSlot,
  loadConfig,
} from "./host/config.ts"
import { updateAll } from "./host/images.ts"
import { networkDown, networkUp } from "./host/net.ts"
import { setup } from "./host/setup.ts"
import { cachePaths, runSlot } from "./host/slot.ts"
import { status } from "./host/status.ts"
import { install } from "./host/systemd.ts"

const HELP =
  `divvun-fc: run Buildkite agents in Firecracker microVMs, one job per VM.

USAGE:
  deno task fc [--config <path>] <command>

COMMANDS:
  setup                    Install Firecracker, the jailer and crane at the
                           versions in firecracker/versions.ts (needs network)
  install                  Write the systemd units and enable one per slot
  status                   Show the kernel, images and every slot
  images update            Convert new kernel and image releases (the timer)
  network up | down        Host forwarding, NAT and firewall (a unit)
  slot run <slot>          Boot the slot's VM, a job at a time (a unit)
  slot reset-cache <slot>  Start the slot's next VM on an empty cache disk

OPTIONS:
  --config <path>   Default ${DEFAULT_CONFIG_PATH}

See firecracker/README.md.`

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv, {
    string: ["config"],
    boolean: ["help"],
    alias: { h: "help" },
  })
  const [command, sub, arg] = args._.map(String)
  if (args.help || !command) {
    console.log(HELP)
    return
  }
  if (command === "setup") return await setup()

  const config = await loadConfig(args.config ?? DEFAULT_CONFIG_PATH)

  switch (`${command} ${sub ?? ""}`.trim()) {
    case "install":
      return await install(config)
    case "status":
      return await status(config)
    case "images update":
      return await updateAll(config)
    case "network up":
      return await networkUp(config)
    case "network down":
      return await networkDown()
    case "slot run":
      return await runSlot(config, findSlot(config, required(arg, "slot")))
    case "slot reset-cache": {
      const { disk, marker } = cachePaths(
        config,
        findSlot(config, required(arg, "slot")),
      )
      await Deno.remove(disk).catch(() => {})
      await Deno.remove(marker).catch(() => {})
      logger.info(
        `Removed ${path.basename(disk)}; the slot's next VM gets an empty one`,
      )
      return
    }
    default:
      throw new ConfigError(`unknown command: ${args._.join(" ")}\n\n${HELP}`)
  }
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new ConfigError(`missing <${name}>\n\n${HELP}`)
  return value
}

if (import.meta.main) {
  try {
    await main(Deno.args)
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message)
      Deno.exit(2)
    }
    throw e
  }
}
