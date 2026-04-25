import type { Tool } from "../lib/image.ts"

/** Configure the Windows ssh-agent service to start automatically and start it. */
export function sshAgentService(): Tool {
  return {
    name: "ssh-agent service (auto-start)",
    render: () =>
      [
        `RUN sc config ssh-agent start= auto ; \\`,
        `    sc start ssh-agent`,
      ].join("\n"),
  }
}
