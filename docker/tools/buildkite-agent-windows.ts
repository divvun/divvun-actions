import type { Tool } from "../lib/image.ts"

/**
 * Bootstrap the buildkite-agent on Windows via the official install.ps1.
 * Adds C:\buildkite-agent\bin to system PATH.
 *
 * The placeholder `BUILDKITE_AGENT_TOKEN` env is required by the install
 * script; real tokens are injected at container start by `update.ps1`.
 */
export function buildkiteAgentWindows(): Tool {
  return {
    name: "buildkite-agent",
    render: () =>
      [
        `ENV buildkiteAgentToken="XXX"`,
        `ENV BUILDKITE_AGENT_TOKEN="XXX"`,
        ``,
        `RUN Set-ExecutionPolicy Bypass -Scope Process -Force; \\`,
        `    iex ((New-Object System.Net.WebClient).DownloadString('https://raw.githubusercontent.com/buildkite/agent/main/install.ps1')); \\`,
        `    setx /M PATH $($Env:PATH + 'C:\\buildkite-agent\\bin;');`,
      ].join("\n"),
  }
}
