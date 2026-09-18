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
 *
 * Packages are installed one per invocation, each retried: the NDK alone is
 * about a gigabyte, and a download that stops short surfaces as
 * `Error on ZipFile unknown archive` — a network failure wearing a parser's
 * error message, which took the whole image build down with it. A retry only
 * helps if the half-written archive goes first, so the partial-download caches
 * are cleared between attempts; sdkmanager will otherwise re-read the same
 * corrupt file and fail identically.
 */
export function androidSdk(opts: AndroidSdkOpts = {}): Tool {
  const url = opts.commandLineToolsUrl ??
    "https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip"
  const platform = opts.platform ?? "android-36"
  const buildTools = opts.buildTools ?? "36.0.0"
  const ndk = opts.ndkVersion ?? versions.ndk
  const packages = [
    "platform-tools",
    `platforms;${platform}`,
    `build-tools;${buildTools}`,
    `ndk;${ndk}`,
  ]
  return {
    name:
      `android SDK (platform=${platform}, build-tools=${buildTools}, ndk=${ndk})`,
    render: () =>
      [
        `RUN set -eu && \\`,
        `    curl -fsSL ${url} -o commandlinetools.zip && \\`,
        `    mkdir -p ~/Android/sdk/cmdline-tools && \\`,
        `    unzip -q commandlinetools.zip -d ~/Android/sdk/cmdline-tools && \\`,
        `    rm commandlinetools.zip && \\`,
        `    mv ~/Android/sdk/cmdline-tools/cmdline-tools ~/Android/sdk/cmdline-tools/latest && \\`,
        `    yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses > /dev/null`,
        ``,
        `RUN set -eu && \\`,
        `    SDKMANAGER=$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager && \\`,
        `    for pkg in ${packages.map((p) => `"${p}"`).join(" ")}; do \\`,
        `      n=1 ; \\`,
        `      until "$SDKMANAGER" "$pkg" ; do \\`,
        `        if [ "$n" -ge 3 ]; then echo "sdkmanager: $pkg failed $n times" >&2; exit 1; fi ; \\`,
        `        echo "sdkmanager: $pkg failed, clearing partial downloads and retrying ($n)" >&2 ; \\`,
        `        rm -rf "$ANDROID_HOME/.temp" "$ANDROID_HOME/.downloadIntermediates" ~/.android/cache ; \\`,
        `        n=$((n + 1)) ; \\`,
        `        sleep 5 ; \\`,
        `      done ; \\`,
        `    done && \\`,
        `    test -d "$ANDROID_NDK_HOME"`,
      ].join("\n"),
  }
}
