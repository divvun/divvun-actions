import { deepEqual, equal, ok } from "node:assert/strict"
import { parseSync } from "@optique/core/parser"

Deno.env.set("BUILDKITE", "true")
Deno.env.set("BUILDKITE_REPO", "git@github.com:divvun/divvun-actions.git")
Deno.env.delete("BUILDKITE_PLUGINS")

const { pipelineActions, repositoryPipeline } = await import("~/cli.ts")
const { pipelineDesktopKeyboard, pipelineDivvunKeyboard } = await import(
  "~/pipelines/keyboard/divvun-keyboard.ts"
)
const { pipelineKeyboardViewer } = await import(
  "~/pipelines/keyboard-viewer.ts"
)
const { pipelineLang } = await import("~/pipelines/lang/mod.ts")
const { pipelineDict } = await import("~/pipelines/dict/mod.ts")
const { pipelineDocsData } = await import("~/pipelines/docsdata/mod.ts")
const { isPrivilegedPipelineAction } = await import(
  "~/util/privileged_action.ts"
)

function parse(command: string[]) {
  const result = parseSync(pipelineActions, command)
  if (!result.success) {
    throw new Error(`${command.join(" ")} did not parse`)
  }
  return result.value
}

// Every `divvun-actions run` command line the pipelines in this repository
// generate, with each interpolated value replaced by one it takes.
const GENERATED = [
  ["borealium-lint"],
  ["borealium-build"],
  ["borealium-deploy"],
  ["borealium-bump-manifest"],
  ["box-publish"],
  ["cg3-rs-publish"],
  ["cg3-rs-npm-publish"],
  ["cg3-rs-pypi-publish"],
  ["cg3-rs-swift-publish"],
  ["dict-build"],
  ["dict-deploy"],
  ["divvun-actions-build-image", "alpine", "push"],
  ["divvun-actions-build-image", "windows-vsbase", "push"],
  ["divvun-runtime-publish"],
  ["divvun-speech-py-export"],
  ["divvun-wind-installer"],
  ["divvun-wind-publish"],
  ["divvun-worker-tts-publish"],
  ["libreoffice-extension-build-oxt-macos"],
  ["libreoffice-extension-installer-macos"],
  ["libreoffice-extension-build-oxt-linux"],
  ["libreoffice-extension-build-oxt-windows", "x86_64"],
  ["libreoffice-extension-installer-windows", "x86_64"],
  ["libreoffice-extension-publish"],
  ["divvunspell-publish"],
  ["libdivvun-fst-publish"],
  ["divvunspell-npm-publish"],
  ["divvunspell-pypi-publish"],
  ["docs-data-publish"],
  ["donate-speech-build-ios"],
  ["donate-speech-deploy-ios"],
  ["donate-speech-build-android"],
  ["donate-speech-deploy-android"],
  ["donate-speech-build-macos"],
  ["donate-speech-deploy-macos"],
  ["donate-speech-build-windows"],
  ["donate-speech-deploy-windows"],
  ["drb-kicker-lint"],
  ["drb-kicker-deploy"],
  ["drb-kicker-bump-manifest"],
  ["foma-rs-publish"],
  ["frakt-publish"],
  ["gut-publish"],
  ["hfst-rs-publish"],
  ["hfst-rs-npm-publish"],
  ["hfst-rs-pypi-publish"],
  ["hfst-rs-swift-publish"],
  ["kbdgen-deploy"],
  ["kbdgen-pahkat-publish"],
  ["kbd-tsf-installer"],
  ["kbd-tsf-publish"],
  ["kbdgen-publish-v4"],
  ["kbdi-publish"],
  ["keyboard-viewer-lint"],
  ["keyboard-viewer-deploy"],
  ["keyboard-viewer-bump-manifest"],
  ["divvun-keyboard-ios"],
  ["divvun-keyboard-android"],
  ["divvun-keyboard-windows-v4", "outto"],
  ["divvun-keyboard-deploy-windows-v4"],
  ["keyboard-pahkat-publish"],
  ["divvun-keyboard-windows", "outto"],
  ["divvun-keyboard-macos", "outto"],
  ["divvun-keyboard-deploy-outto"],
  ["divvun-keyboard-windows"],
  ["divvun-keyboard-deploy-windows"],
  ["divvun-keyboard-macos"],
  ["divvun-keyboard-deploy-macos"],
  ["lang-deps"],
  ["lang-speller-build"],
  ["lang-grammar-build"],
  ["lang-tts-textproc-build"],
  ["lang-teaksta-bundle-build"],
  ["lang-analyser-build"],
  ["lang-proofing-build"],
  ["lang-speller-test"],
  ["lang-grammar-test"],
  ["lang-docs-publish"],
  ["lang-bundle", "windows"],
  ["lang-bundle", "mobile"],
  ["lang-bundle", "macos"],
  ["lang-proofing-bundle", "macos"],
  ["lang-proofing-bundle", "windows"],
  ["lang-proofing-bundle", "linux"],
  ["lang-deploy"],
  ["lang-grammar-deploy"],
  ["lang-proofing-deploy"],
  ["proofing-pahkat-publish"],
  ["lang-tts-textproc-deploy"],
  ["lang-teaksta-bundle-deploy"],
  ["lang-analyser-deploy"],
  ["macos-sign", "target/release/box"],
  [
    "macos-sign",
    "./Divvun Runtime Playground.app",
    "",
    "./playground/src-tauri/Entitlements.plist",
  ],
  ["msgrammar-installer"],
  ["msgrammar-publish"],
  ["outto-publish"],
  ["pahkat-cli-publish"],
  ["pahkat-mobile-swift-archive"],
  ["pahkat-mobile-swift-publish"],
  ["pahkat-mobile-maven-publish"],
  ["pahkat-server-deploy"],
  ["pahkat-server-bump-manifest"],
  ["libpahkat-android"],
  ["libpahkat-ios"],
  ["libpahkat-publish"],
  ["pdf-strings-publish"],
  ["rsigncode-publish"],
  ["subethaedit-build-macos"],
  ["subethaedit-publish"],
  ["teaksta-check"],
  ["teaksta-models"],
  ["teaksta-deploy"],
  ["teaksta-bump-manifest"],
  ["divvun-worker-grammar-deploy"],
  ["divvun-worker-grammar-bump-manifest"],
  ["divvun-worker-speller-deploy"],
  ["divvun-worker-speller-bump-manifest"],
]

Deno.test("every generated run command parses to its own action", () => {
  for (const command of GENERATED) {
    equal(parse(command).name, command[0])
  }
})

Deno.test("the trust gate sees each action's arguments as given", () => {
  for (const command of GENERATED) {
    const action = parse(command)
    equal(
      isPrivilegedPipelineAction(action.name, action.args),
      isPrivilegedPipelineAction(command[0], command.slice(1)),
      command.join(" "),
    )
  }
  ok(isPrivilegedPipelineAction(
    ...nameAndArgs(["divvun-actions-build-image", "linux", "push"]),
  ))
  ok(
    !isPrivilegedPipelineAction(
      ...nameAndArgs(["divvun-actions-build-image", "linux", "no-push"]),
    ),
  )
})

function nameAndArgs(command: string[]): [string, readonly string[]] {
  const action = parse(command)
  return [action.name, action.args]
}

Deno.test("arguments stay strings", () => {
  deepEqual(parse(["macos-sign", "App.app", "1.10"]).args, [
    "App.app",
    "1.10",
  ])
})

Deno.test("an optional installer falls back to its default", () => {
  deepEqual(parse(["divvun-keyboard-windows-v4"]).args, ["outto"])
  deepEqual(parse(["divvun-keyboard-windows"]).args, [])
})

Deno.test("a command line no action accepts does not parse", () => {
  for (
    const command of [
      [],
      ["divvunspell"],
      ["lang-speler-build"],
      ["lang-deps", "extra"],
      ["lang-bundle"],
      ["lang-bundle", "window"],
      ["divvun-keyboard-windows", "outo"],
      ["libreoffice-extension-build-oxt-windows", "arm64"],
      ["divvun-actions-build-image", "linux"],
      ["divvun-actions-build-image", "linux", "--push"],
      ["macos-sign"],
    ]
  ) {
    equal(
      parseSync(pipelineActions, command).success,
      false,
      command.join(" "),
    )
  }
})

Deno.test("a repository's own pipeline wins over its family's", () => {
  equal(repositoryPipeline("keyboard-viewer"), pipelineKeyboardViewer)
  equal(repositoryPipeline("keyboard-sme"), pipelineDesktopKeyboard)
  equal(repositoryPipeline("giella-core"), pipelineDocsData)
})

Deno.test("each family of repositories gets its pipeline", () => {
  equal(repositoryPipeline("lang-sme"), pipelineLang)
  equal(repositoryPipeline("dict-sme-nob"), pipelineDict)
  equal(repositoryPipeline("shared-mul"), pipelineDocsData)
  equal(repositoryPipeline("template-lang-und"), pipelineDocsData)
})

Deno.test("repository names match in any case", () => {
  equal(repositoryPipeline("Divvun-Dev-Keyboard"), pipelineDivvunKeyboard)
  equal(repositoryPipeline("LANG-SME"), pipelineLang)
})

Deno.test("a repository no pipeline covers has none", () => {
  for (const name of ["unknown", "constructor", "toString", "lang"]) {
    equal(repositoryPipeline(name), undefined, name)
  }
})
