export type KbdgenCargoToml = {
  package: {
    name: string
    version: string
    description?: string
    authors?: string[]
  }
  dependencies?: Record<string, any>
  [key: string]: any
}

export enum KbdgenPlatform {
  Windows = "windows",
  MacOS = "macos",
  Linux = "linux",
}

export type KbdgenArtifact = {
  path: string
  platform: KbdgenPlatform
  rustTarget: string
}
