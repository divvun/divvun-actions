export type DivvunActionsConfig = {
  targets?: {
    macos?: DivvunActionsTargetMacOSConfig
    windows?: DivvunActionsTargetWindowsConfig
    linux?: DivvunActionsTargetLinuxConfig
  }
}

export type DivvunActionsTargetMacOSConfig = {
  remote?: string
}

export type DivvunActionsTargetWindowsConfig = {
  context?: string
  remote?: string
}

export type DivvunActionsTargetLinuxConfig = {
  context?: string
  remote?: string
}
