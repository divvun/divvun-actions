import type { Tool } from "../lib/image.ts"

/**
 * Install msvc-env (helper that exposes MSVC toolchain env vars to non-VS
 * shells). Bundle hosted at x.giellalt.org.
 */
export function msvcEnv(): Tool {
  return {
    name: "msvc-env",
    render: () =>
      [
        `RUN Invoke-WebRequest -Uri https://x.giellalt.org/msvc-env.zip -OutFile msvc-env.zip ; \\`,
        `    Expand-Archive msvc-env.zip -DestinationPath C:\\bin ; \\`,
        `    Remove-Item -Force msvc-env.zip`,
      ].join("\n"),
  }
}
