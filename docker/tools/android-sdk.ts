import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

export type AndroidSdkOpts = {
  commandLineToolsUrl?: string
  platform?: string
  buildTools?: string
  ndkVersion?: string
}

/**
 * Install the Android command-line tools and use `sdkmanager` to install
 * platform-tools, an API platform, build-tools, and the NDK.
 *
 * Requires `unzip` + `openjdk-17-jdk` to already be installed (via aptPackages).
 * Requires ANDROID_HOME + ANDROID_NDK_HOME to be set in the image `env`.
 */
export function androidSdk(opts: AndroidSdkOpts = {}): Tool {
  const url = opts.commandLineToolsUrl ??
    "https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip"
  const platform = opts.platform ?? "android-35"
  const buildTools = opts.buildTools ?? "35.0.1"
  const ndk = opts.ndkVersion ?? versions.ndk
  return {
    name:
      `android SDK (platform=${platform}, build-tools=${buildTools}, ndk=${ndk})`,
    render: () =>
      [
        `RUN curl -fsSL ${url} -o commandlinetools.zip && \\`,
        `    mkdir -p ~/Android/sdk/cmdline-tools && \\`,
        `    unzip commandlinetools.zip -d ~/Android/sdk/cmdline-tools && \\`,
        `    rm commandlinetools.zip && \\`,
        `    mv ~/Android/sdk/cmdline-tools/cmdline-tools ~/Android/sdk/cmdline-tools/latest && \\`,
        `    yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses && \\`,
        `    $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager \\`,
        `    "platform-tools" \\`,
        `    "platforms;${platform}" \\`,
        `    "build-tools;${buildTools}" \\`,
        `    "ndk;${ndk}"`,
      ].join("\n"),
  }
}
