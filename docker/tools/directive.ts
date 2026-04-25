import type { Tool } from "../lib/image.ts"

/** Emit a raw block of Dockerfile content (RUN, ENV, anything). */
export function raw(name: string, content: string): Tool {
  return { name, render: () => content }
}

/** Emit `ARG <name>=<default>` */
export function arg(name: string, defaultValue: string): Tool {
  return {
    name: `ARG ${name}`,
    render: () => `ARG ${name}=${defaultValue}`,
  }
}

/** Emit an `ADD <url> <dest>` directive (Docker downloads the URL at build time). */
export function addUrl(label: string, url: string, dest: string): Tool {
  return {
    name: label,
    render: () => `ADD ${url} ${dest}`,
  }
}

/** Emit a `COPY <src> <dest>` directive (file from build context into image). */
export function copyFile(label: string, src: string, dest: string): Tool {
  return {
    name: label,
    render: () => `COPY ${src} ${dest}`,
  }
}

/** Emit a `USER <user>` directive — used to switch the active user mid-Dockerfile. */
export function setUser(user: string): Tool {
  return {
    name: `USER ${user}`,
    render: () => `USER ${user}`,
  }
}

/**
 * Emit one or more `ENV` lines. Useful for setting envs that depend on
 * a tool-installed binary (e.g. VCPKG_ROOT after vcpkg is bootstrapped).
 */
export function envVars(label: string, vars: Record<string, string>): Tool {
  return {
    name: label,
    render: () =>
      Object.entries(vars).map(([k, v]) => `ENV ${k}=${JSON.stringify(v)}`)
        .join("\n"),
  }
}
