import * as path from "@std/path"
import logger from "~/util/log.ts"
import { run } from "./cmd.ts"
import type { Config } from "./config.ts"

const UNIT_DIR = "/etc/systemd/system"
const WANTS_DIR = `${UNIT_DIR}/multi-user.target.wants`
const SLOT_UNIT = "divvun-fc@.service"
const NETWORK_UNIT = "divvun-fc-network.service"
const IMAGES_UNIT = "divvun-fc-images.service"
const IMAGES_TIMER = "divvun-fc-images.timer"

export const DENO_PERMISSIONS = [
  "--allow-read",
  "--allow-write",
  "--allow-run",
  "--allow-env",
  "--allow-sys",
]

/**
 * The units, by file name, running `cli` from the checkout at `repo`. Deno
 * finds deno.jsonc, and with it the import map, from the working directory.
 */
export function renderUnits(opts: {
  deno: string
  repo: string
  cli: string
  configPath: string
}): Record<string, string> {
  const exec = (args: string) =>
    [
      opts.deno,
      "run",
      ...DENO_PERMISSIONS,
      opts.cli,
      "--config",
      opts.configPath,
      args,
    ]
      .join(" ")
  const generated =
    "# Written by `divvun-fc install` (firecracker/host/systemd.ts).\n"
  return {
    [NETWORK_UNIT]: `${generated}
[Unit]
Description=divvun-fc: host networking for the Buildkite microVMs
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${opts.repo}
ExecStart=${exec("network up")}
ExecStop=${exec("network down")}

[Install]
WantedBy=multi-user.target
`,
    [SLOT_UNIT]: `${generated}
[Unit]
Description=divvun-fc: Buildkite microVM slot %i
Requires=${NETWORK_UNIT}
After=${NETWORK_UNIT}

[Service]
WorkingDirectory=${opts.repo}
ExecStart=${exec("slot run %i")}
Restart=always
RestartSec=10
# SIGTERM to the runner alone: it asks the guest to finish its job and shut
# down, which can take as long as the job does.
KillMode=mixed
TimeoutStopSec=infinity

[Install]
WantedBy=multi-user.target
`,
    [IMAGES_UNIT]: `${generated}
[Unit]
Description=divvun-fc: convert new kernel and image releases for the microVMs
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${opts.repo}
ExecStart=${exec("images update")}
`,
    [IMAGES_TIMER]: `${generated}
[Unit]
Description=divvun-fc: look for new kernel and image releases

[Timer]
OnBootSec=1min
OnUnitInactiveSec=5min

[Install]
WantedBy=timers.target
`,
  }
}

async function enabledSlots(): Promise<string[]> {
  const slots: string[] = []
  try {
    for await (const entry of Deno.readDir(WANTS_DIR)) {
      const m = entry.name.match(/^divvun-fc@(.+)\.service$/)
      if (m) slots.push(m[1])
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e
  }
  return slots
}

/**
 * Write the units, then make the enabled slots exactly the configured ones.
 * Slots that went away are stopped without waiting, since a graceful stop
 * lasts as long as the job in it.
 */
export async function install(config: Config): Promise<void> {
  const cli = path.fromFileUrl(new URL("../cli.ts", import.meta.url))
  const units = renderUnits({
    deno: Deno.execPath(),
    repo: path.dirname(path.dirname(cli)),
    cli,
    configPath: path.resolve(config.path),
  })
  for (const [name, text] of Object.entries(units)) {
    await Deno.writeTextFile(path.join(UNIT_DIR, name), text)
    logger.info(`Wrote ${path.join(UNIT_DIR, name)}`)
  }
  await run("systemctl", ["daemon-reload"])
  await run("systemctl", ["enable", "--now", NETWORK_UNIT, IMAGES_TIMER])
  await run("systemctl", ["start", "--no-block", IMAGES_UNIT])

  const wanted = new Set(config.slots.map((s) => s.name))
  for (const name of await enabledSlots()) {
    if (!wanted.has(name)) {
      logger.info(`Removing slot ${name}, once its job finishes`)
      await run("systemctl", [
        "disable",
        "--now",
        "--no-block",
        `divvun-fc@${name}.service`,
      ])
    }
  }
  for (const slot of config.slots) {
    await run("systemctl", [
      "enable",
      "--now",
      "--no-block",
      `divvun-fc@${slot.name}.service`,
    ])
  }
  logger.info(
    `Enabled ${config.slots.length} slot(s): ${
      config.slots.map((s) => s.name).join(", ")
    }`,
  )
}
