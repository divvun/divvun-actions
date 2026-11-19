import { group, object, or } from "@optique/core/constructs"
import { message } from "@optique/core/message"
import { map, optional, withDefault } from "@optique/core/modifiers"
import type { Parser } from "@optique/core/parser"
import { argument, command, constant } from "@optique/core/primitives"
import { choice, string } from "@optique/core/valueparser"
import { run } from "@optique/run"
import * as yaml from "@std/yaml"
import { KeyboardType } from "~/actions/keyboard/types.ts"
import * as builder from "~/builder.ts"
import {
  pipelineMsgrammar,
  runMsgrammarInstaller,
  runMsgrammarPublish,
} from "~/pipelines/msgrammar.ts"
import { BuildkitePipeline } from "~/builder/pipeline.ts"
import { BUILD_TIMESTAMP } from "~/util/env.ts"
import {
  desktopKeyboardBundlePath,
  pipelineDesktopKeyboard,
  pipelineDivvunKeyboard,
  runDesktopKeyboardDeploy,
  runDesktopKeyboardDeployOutto,
  runDesktopKeyboardDeployWindowsV4,
  runDesktopKeyboardMacOS,
  runDesktopKeyboardWindows,
  runDivvunKeyboardAndroid,
  runDivvunKeyboardIOS,
} from "~/pipelines/keyboard/divvun-keyboard.ts"
import { logJobEnvironment } from "~/util/job_environment.ts"
import logger from "~/util/log.ts"
import { runKbdgenDeploy } from "./actions/kbdgen/deploy.ts"
import {
  pipelineDivvunRuntime,
  runDivvunRuntimePublish,
} from "./pipelines/divvun-runtime.ts"
import { pipelineGut, runGutPublish } from "./pipelines/gut.ts"
import {
  pipelineDivvunWorkerTts,
  runDivvunWorkerTtsPublish,
} from "./pipelines/divvun-worker-tts.ts"
import {
  pipelineDivvunSpeechPy,
  runDivvunSpeechPyExport,
} from "./pipelines/divvun-speech-py.ts"
import { pipelineBox, runBoxPublish } from "./pipelines/box.ts"
import {
  pipelineDivvunWind,
  runWindInstaller,
  runWindPublish,
} from "./pipelines/divvun-wind.ts"
import { pipelineOutto, runOuttoPublish } from "./pipelines/outto.ts"
import {
  pipelineRsigncode,
  runRsigncodePublish,
} from "./pipelines/rsigncode.ts"
import {
  pipelineHfstRs,
  runHfstRsNpmPublish,
  runHfstRsPublish,
  runHfstRsPypiPublish,
  runHfstRsSwiftPublish,
} from "./pipelines/hfst-rs.ts"
import { pipelineFomaRs, runFomaRsPublish } from "./pipelines/foma-rs.ts"
import {
  pipelineCg3Rs,
  runCg3RsNpmPublish,
  runCg3RsPublish,
  runCg3RsPypiPublish,
  runCg3RsSwiftPublish,
} from "./pipelines/cg3-rs.ts"
import {
  pipelineDivvunActions,
  runDivvunActionsBuildImage,
} from "./pipelines/divvun-actions.ts"
import {
  pipelineBorealium,
  runBorealiumBuild,
  runBorealiumBumpManifest,
  runBorealiumDeploy,
  runBorealiumLint,
} from "./pipelines/borealium.ts"
import {
  pipelineKeyboardViewer,
  runKeyboardViewerBumpManifest,
  runKeyboardViewerDeploy,
  runKeyboardViewerLint,
} from "./pipelines/keyboard-viewer.ts"
import {
  pipelineDrbKicker,
  runDrbKickerBumpManifest,
  runDrbKickerDeploy,
  runDrbKickerLint,
} from "./pipelines/drb-kicker.ts"
import {
  pipelineTeaksta,
  runTeakstaBumpManifest,
  runTeakstaCheck,
  runTeakstaDeploy,
  runTeakstaModels,
} from "./pipelines/teaksta.ts"
import {
  pipelinePahkatServer,
  runPahkatServerBumpManifest,
  runPahkatServerDeploy,
} from "./pipelines/pahkat-server.ts"
import { runPahkatCliPublish } from "./pipelines/pahkat-cli.ts"
import { pipelineFrakt, runFraktPublish } from "./pipelines/frakt.ts"
import {
  runPahkatMobileMavenPublish,
  runPahkatMobileSwiftArchive,
  runPahkatMobileSwiftPublish,
} from "./pipelines/pahkat-mobile.ts"
import {
  DIVVUN_WORKER_GRAMMAR,
  DIVVUN_WORKER_SPELLER,
  pipelineWorkerCd,
  runWorkerCdBumpManifest,
  runWorkerCdDeploy,
} from "./pipelines/worker-cd.ts"
import {
  pipelineDict,
  runDictBuild,
  runDictDeploy,
} from "./pipelines/dict/mod.ts"
import { pipelineDocsData } from "./pipelines/docsdata/mod.ts"
import { runDocsDataPublish } from "./actions/docsdata/publish.ts"
import {
  pipelineDivvunspell,
  runDivvunspellNpmPublish,
  runDivvunspellPublish,
  runDivvunspellPypiPublish,
  runLibdivvunFstPublish,
} from "./pipelines/divvunspell/mod.ts"
import { pipelineKbdgen } from "./pipelines/kbdgen/mod.ts"
import { runKbdgenPahkatPublish } from "./pipelines/kbdgen/pahkat.ts"
import { runTipInstaller, runTipPublish } from "./pipelines/kbdgen/tip.ts"
import { runKbdgenPublishV4 } from "./pipelines/kbdgen/v4.ts"
import { runKeyboardPahkatPublish } from "./pipelines/keyboard/pahkat.ts"
import { pipelineKbdi, runKbdiPublish } from "./pipelines/kbdi/mod.ts"
import {
  pipelineLang,
  runLangAnalyserBuild,
  runLangAnalyserDeploy,
  runLangBundle,
  runLangDeploy,
  runLangDeps,
  runLangDocsPublish,
  runLangGrammarBuild,
  runLangGrammarDeploy,
  runLangGrammarTest,
  runLangProofingBuild,
  runLangProofingBundle,
  runLangProofingDeploy,
  runLangSpellerBuild,
  runLangSpellerTest,
  runLangTeakstaBundleBuild,
  runLangTeakstaBundleDeploy,
  runLangTtsTextprocBuild,
  runLangTtsTextprocDeploy,
} from "./pipelines/lang/mod.ts"
import { runProofingPahkatPublish } from "./pipelines/lang/pahkat.ts"
import pipelineLibpahkat, {
  runLibpahkatAndroid,
  runLibpahkatIos,
  runLibpahkatPublish,
} from "./pipelines/pahkat/libpahkat.ts"
import {
  pipelineDonateSpeech,
  runDonateSpeechBuildAndroid,
  runDonateSpeechBuildIOS,
  runDonateSpeechBuildMacOS,
  runDonateSpeechBuildWindows,
  runDonateSpeechDeployAndroid,
  runDonateSpeechDeployIOS,
  runDonateSpeechDeployMacOS,
  runDonateSpeechDeployWindows,
} from "./pipelines/donate-speech/mod.ts"
import {
  pipelineLibreOfficeExtension,
  runLibreOfficeExtensionLinuxOxt,
  runLibreOfficeExtensionMacosInstaller,
  runLibreOfficeExtensionMacosOxt,
  runLibreOfficeExtensionPublish,
  runLibreOfficeExtensionWindowsInstaller,
  runLibreOfficeExtensionWindowsOxt,
} from "./pipelines/divvunspell-libreoffice/mod.ts"
import type { WindowsArch } from "./pipelines/divvunspell-libreoffice/windows.ts"
import {
  pipelinePdfStrings,
  runPdfStringsPublish,
} from "./pipelines/pdf-strings/mod.ts"
import {
  pipelineSubethaedit,
  runSubethaeditBuildMacOS,
  runSubethaeditPublish,
} from "./pipelines/subethaedit.ts"
import macosSign from "./services/macos-codesign.ts"
import sign from "./services/windows-codesign.ts"
import { makeTempFile } from "./util/temp.ts"
import type { InstallerKind } from "./actions/keyboard/build/mod.ts"
import type { ProofingTarget } from "./actions/proofing/bundle.ts"
import {
  isPrivilegedPipelineAction,
  securePipelineForContext,
} from "./util/privileged_action.ts"
import { requireTrustedReleaseContext } from "./util/trusted_context.ts"

/** One `divvun-actions run` action, as its command line parsed. */
type Action = {
  readonly name: string
  /**
   * The action's arguments, which `isPrivilegedPipelineAction` reads
   * alongside its name, as `commandRequiresTrustedContext` reads them in a
   * generated step's command.
   */
  readonly args: readonly string[]
  readonly run: () => Promise<void>
}

type ActionParser = Parser<"sync", Action, unknown>
type ActionArgs = Record<string, string | undefined>

function action(name: string, handler: () => Promise<void>): ActionParser
function action<T extends ActionArgs>(
  name: string,
  args: Parser<"sync", T, unknown>,
  handler: (args: T) => Promise<void>,
): ActionParser
function action(
  name: string,
  argsOrHandler: Parser<"sync", ActionArgs, unknown> | (() => Promise<void>),
  handler?: (args: ActionArgs) => Promise<void>,
): ActionParser {
  const [args, run] = typeof argsOrHandler === "function"
    ? [object({}), argsOrHandler]
    : [argsOrHandler, handler!]
  return command(
    name,
    map(args, (value: ActionArgs) => ({
      name,
      args: Object.values(value).filter((arg) => arg != null),
      run: () => run(value),
    })),
  )
}

const installer = (fallback?: InstallerKind) => {
  const parser = argument(
    choice<InstallerKind>(["outto", "legacy"], { metavar: "INSTALLER" }),
    {
      description: message`The installer to build`,
    },
  )
  return fallback == null ? optional(parser) : withDefault(parser, fallback)
}

const windowsArch = argument(
  choice<WindowsArch>(["x86_64", "aarch64"], { metavar: "ARCH" }),
)

function kbdgenBundlePathMobile(): string {
  return builder.env.repoName.toLowerCase() === "divvun-dev-keyboard"
    ? "divvun-dev.kbdgen"
    : "divvun.kbdgen"
}

const languageActions: ActionParser[] = [
  action("lang-deps", runLangDeps),
  action("lang-speller-build", runLangSpellerBuild),
  action("lang-speller-test", runLangSpellerTest),
  action("lang-grammar-build", runLangGrammarBuild),
  action("lang-grammar-test", runLangGrammarTest),
  action("lang-grammar-deploy", runLangGrammarDeploy),
  action(
    "lang-bundle",
    object({
      target: argument(
        choice<Parameters<typeof runLangBundle>[0]["target"]>([
          "windows",
          "macos",
          "mobile",
        ], { metavar: "TARGET" }),
      ),
    }),
    runLangBundle,
  ),
  action("lang-deploy", runLangDeploy),
  action("lang-proofing-build", runLangProofingBuild),
  action(
    "lang-proofing-bundle",
    object({
      target: argument(
        choice<ProofingTarget>(["macos", "windows", "linux"], {
          metavar: "TARGET",
        }),
      ),
    }),
    runLangProofingBundle,
  ),
  action("lang-proofing-deploy", runLangProofingDeploy),
  action("proofing-pahkat-publish", runProofingPahkatPublish),
  action("lang-tts-textproc-build", runLangTtsTextprocBuild),
  action("lang-tts-textproc-deploy", runLangTtsTextprocDeploy),
  action("lang-analyser-build", runLangAnalyserBuild),
  action("lang-analyser-deploy", runLangAnalyserDeploy),
  action("lang-teaksta-bundle-build", runLangTeakstaBundleBuild),
  action("lang-teaksta-bundle-deploy", runLangTeakstaBundleDeploy),
  action("lang-docs-publish", runLangDocsPublish),
  action("docs-data-publish", runDocsDataPublish),
]

const dictionaryActions: ActionParser[] = [
  action("dict-build", runDictBuild),
  action("dict-deploy", runDictDeploy),
]

const keyboardActions: ActionParser[] = [
  action(
    "divvun-keyboard-ios",
    () => runDivvunKeyboardIOS(kbdgenBundlePathMobile()),
  ),
  action(
    "divvun-keyboard-android",
    () => runDivvunKeyboardAndroid(kbdgenBundlePathMobile()),
  ),
  action(
    "divvun-keyboard-windows",
    object({ installer: installer() }),
    ({ installer }) =>
      runDesktopKeyboardWindows(desktopKeyboardBundlePath(), installer),
  ),
  action(
    "divvun-keyboard-windows-v4",
    object({ installer: installer("outto") }),
    ({ installer }) =>
      runDesktopKeyboardWindows(desktopKeyboardBundlePath(), installer, "v4"),
  ),
  action(
    "divvun-keyboard-macos",
    object({ installer: installer() }),
    ({ installer }) =>
      runDesktopKeyboardMacOS(desktopKeyboardBundlePath(), installer),
  ),
  action(
    "divvun-keyboard-deploy-windows",
    () => runDesktopKeyboardDeploy(KeyboardType.Windows),
  ),
  action(
    "divvun-keyboard-deploy-macos",
    () => runDesktopKeyboardDeploy(KeyboardType.MacOS),
  ),
  action("divvun-keyboard-deploy-outto", runDesktopKeyboardDeployOutto),
  action(
    "divvun-keyboard-deploy-windows-v4",
    runDesktopKeyboardDeployWindowsV4,
  ),
  action("keyboard-pahkat-publish", runKeyboardPahkatPublish),
  action("kbdgen-deploy", runKbdgenDeploy),
  action("kbdgen-pahkat-publish", runKbdgenPahkatPublish),
  action("kbdgen-publish-v4", runKbdgenPublishV4),
  action("kbdi-publish", runKbdiPublish),
  action("kbd-tsf-installer", runTipInstaller),
  action("kbd-tsf-publish", runTipPublish),
]

const libraryActions: ActionParser[] = [
  action("divvunspell-publish", runDivvunspellPublish),
  action("divvunspell-npm-publish", runDivvunspellNpmPublish),
  action("divvunspell-pypi-publish", runDivvunspellPypiPublish),
  action("libdivvun-fst-publish", runLibdivvunFstPublish),
  action("hfst-rs-publish", runHfstRsPublish),
  action("hfst-rs-npm-publish", runHfstRsNpmPublish),
  action("hfst-rs-pypi-publish", runHfstRsPypiPublish),
  action("hfst-rs-swift-publish", runHfstRsSwiftPublish),
  action("foma-rs-publish", runFomaRsPublish),
  action("cg3-rs-publish", runCg3RsPublish),
  action("cg3-rs-npm-publish", runCg3RsNpmPublish),
  action("cg3-rs-pypi-publish", runCg3RsPypiPublish),
  action("cg3-rs-swift-publish", runCg3RsSwiftPublish),
  action("divvun-runtime-publish", runDivvunRuntimePublish),
  action("gut-publish", runGutPublish),
  action("box-publish", runBoxPublish),
  action("outto-publish", runOuttoPublish),
  action("rsigncode-publish", runRsigncodePublish),
  action("pahkat-cli-publish", runPahkatCliPublish),
  action("libpahkat-android", runLibpahkatAndroid),
  action("libpahkat-ios", runLibpahkatIos),
  action("libpahkat-publish", runLibpahkatPublish),
  action("pahkat-mobile-swift-archive", runPahkatMobileSwiftArchive),
  action("pahkat-mobile-swift-publish", runPahkatMobileSwiftPublish),
  action("pahkat-mobile-maven-publish", runPahkatMobileMavenPublish),
  action("frakt-publish", runFraktPublish),
  action("pdf-strings-publish", runPdfStringsPublish),
]

const applicationActions: ActionParser[] = [
  action("msgrammar-installer", runMsgrammarInstaller),
  action("msgrammar-publish", runMsgrammarPublish),
  action("divvun-wind-installer", runWindInstaller),
  action("divvun-wind-publish", runWindPublish),
  action("donate-speech-build-ios", runDonateSpeechBuildIOS),
  action("donate-speech-deploy-ios", runDonateSpeechDeployIOS),
  action("donate-speech-build-android", runDonateSpeechBuildAndroid),
  action("donate-speech-deploy-android", runDonateSpeechDeployAndroid),
  action("donate-speech-build-macos", runDonateSpeechBuildMacOS),
  action("donate-speech-deploy-macos", runDonateSpeechDeployMacOS),
  action("donate-speech-build-windows", runDonateSpeechBuildWindows),
  action("donate-speech-deploy-windows", runDonateSpeechDeployWindows),
  action(
    "libreoffice-extension-build-oxt-macos",
    runLibreOfficeExtensionMacosOxt,
  ),
  action(
    "libreoffice-extension-installer-macos",
    runLibreOfficeExtensionMacosInstaller,
  ),
  action(
    "libreoffice-extension-build-oxt-linux",
    runLibreOfficeExtensionLinuxOxt,
  ),
  action(
    "libreoffice-extension-build-oxt-windows",
    object({ arch: windowsArch }),
    ({ arch }) => runLibreOfficeExtensionWindowsOxt(arch),
  ),
  action(
    "libreoffice-extension-installer-windows",
    object({ arch: windowsArch }),
    ({ arch }) => runLibreOfficeExtensionWindowsInstaller(arch),
  ),
  action("libreoffice-extension-publish", runLibreOfficeExtensionPublish),
  action("subethaedit-build-macos", runSubethaeditBuildMacOS),
  action("subethaedit-publish", runSubethaeditPublish),
  action("divvun-speech-py-export", runDivvunSpeechPyExport),
]

const serviceActions: ActionParser[] = [
  action("borealium-lint", runBorealiumLint),
  action("borealium-build", runBorealiumBuild),
  action("borealium-deploy", runBorealiumDeploy),
  action("borealium-bump-manifest", runBorealiumBumpManifest),
  action("keyboard-viewer-lint", runKeyboardViewerLint),
  action("keyboard-viewer-deploy", runKeyboardViewerDeploy),
  action("keyboard-viewer-bump-manifest", runKeyboardViewerBumpManifest),
  action("drb-kicker-lint", runDrbKickerLint),
  action("drb-kicker-deploy", runDrbKickerDeploy),
  action("drb-kicker-bump-manifest", runDrbKickerBumpManifest),
  action("teaksta-check", runTeakstaCheck),
  action("teaksta-models", runTeakstaModels),
  action("teaksta-deploy", runTeakstaDeploy),
  action("teaksta-bump-manifest", runTeakstaBumpManifest),
  action("pahkat-server-deploy", runPahkatServerDeploy),
  action("pahkat-server-bump-manifest", runPahkatServerBumpManifest),
  ...[DIVVUN_WORKER_GRAMMAR, DIVVUN_WORKER_SPELLER].flatMap((worker) => [
    action(`${worker.name}-deploy`, () => runWorkerCdDeploy(worker)),
    action(
      `${worker.name}-bump-manifest`,
      () => runWorkerCdBumpManifest(worker),
    ),
  ]),
  action("divvun-worker-tts-publish", runDivvunWorkerTtsPublish),
]

const divvunActionsActions: ActionParser[] = [
  action(
    "divvun-actions-build-image",
    object({
      target: argument(string({ metavar: "TARGET" }), {
        description: message`The image to build, such as alpine or linux`,
      }),
      push: argument(choice(["push", "no-push"], { metavar: "PUSH" })),
    }),
    ({ target, push }) => runDivvunActionsBuildImage(target, push),
  ),
  action(
    "macos-sign",
    object({
      file: argument(string({ metavar: "FILE" })),
      version: optional(argument(string({ metavar: "VERSION" }), {
        description: message`The version to stamp, or '' for none`,
      })),
      entitlements: optional(argument(string({ metavar: "ENTITLEMENTS" }), {
        description: message`An entitlements plist, or '' for none`,
      })),
    }),
    ({ file, version, entitlements }) =>
      macosSign(file, version || undefined, entitlements || undefined),
  ),
  action("debug", () => {
    logger.info("Environment:")
    logger.info(JSON.stringify(builder.env, null, 2))
    return Promise.resolve()
  }),
]

export const pipelineActions = or(
  group("Languages", or(...languageActions)),
  group("Dictionaries", or(...dictionaryActions)),
  group("Keyboards", or(...keyboardActions)),
  group("Libraries and tools", or(...libraryActions)),
  group("Applications", or(...applicationActions)),
  group("Services", or(...serviceActions)),
  group("divvun-actions", or(...divvunActionsActions)),
)

const cli = or(
  command("run", map(pipelineActions, (action) => () => runAction(action)), {
    brief: message`Run one action of a pipeline`,
  }),
  command("ci", constant(runCi), {
    brief: message`Generate this repository's pipeline and upload it`,
  }),
  command(
    "sign",
    map(
      object({
        file: argument(string({ metavar: "FILE" })),
        skip: withDefault(
          argument(choice(["true", "false"], { metavar: "SKIP" }), {
            description: message`true to leave the file unsigned`,
          }),
          "false",
        ),
      }),
      (args) => () => runSign(args),
    ),
    { brief: message`Sign a Windows executable` },
  ),
)

export default async function runCli(input: string[]) {
  const logLevel = Deno.env.get("LOG_LEVEL")
  if (logLevel) {
    logger.setLogLevel(logLevel)
  }

  const execute = run(cli, {
    programName: "divvun-actions",
    args: input,
    help: { option: { names: ["--help", "-h"] } },
    aboveError: "none",
    showUsage: false,
    commandList: "top-level",
  })
  await execute()
}

async function runAction(action: Action) {
  if (isPrivilegedPipelineAction(action.name, action.args)) {
    requireTrustedReleaseContext(builder.env, `run '${action.name}'`)
  }
  await action.run()
}

async function runSign({ file, skip }: { file: string; skip: string }) {
  if (skip === "true") {
    return
  }
  requireTrustedReleaseContext(builder.env, "sign an artifact")
  await sign(file)
}

type PipelineFactory = () => BuildkitePipeline | Promise<BuildkitePipeline>

const REPOSITORY_PIPELINES = new Map<string, PipelineFactory>([
  ["msgrammar", pipelineMsgrammar],
  ["divvunspell", pipelineDivvunspell],
  ["divvun-keyboard", pipelineDivvunKeyboard],
  ["divvun-dev-keyboard", pipelineDivvunKeyboard],
  ["kbdgen", pipelineKbdgen],
  ["kbdi", pipelineKbdi],
  ["divvun-runtime", pipelineDivvunRuntime],
  ["gut", pipelineGut],
  ["divvun-worker-tts", pipelineDivvunWorkerTts],
  ["divvun-speech-py", pipelineDivvunSpeechPy],
  ["box", pipelineBox],
  ["divvun-wind", pipelineDivvunWind],
  ["outto", pipelineOutto],
  ["rsigncode", pipelineRsigncode],
  ["hfst-rs", pipelineHfstRs],
  ["foma-rs", pipelineFomaRs],
  ["cg3-rs", pipelineCg3Rs],
  ["divvun-actions", pipelineDivvunActions],
  ["borealium.org", pipelineBorealium],
  ["keyboard-viewer", pipelineKeyboardViewer],
  ["drb-kicker", pipelineDrbKicker],
  ["teaksta", pipelineTeaksta],
  ["pahkat-next", pipelinePahkatServer],
  ["frakt", pipelineFrakt],
  ["divvun-worker-grammar", () => pipelineWorkerCd(DIVVUN_WORKER_GRAMMAR)],
  ["divvun-worker-speller", () => pipelineWorkerCd(DIVVUN_WORKER_SPELLER)],
  ["pahkat", () => {
    if (builder.env.pipelineSlug !== "libpahkat") {
      throw new Error(`Unknown pipeline slug: ${builder.env.pipelineSlug}`)
    }
    return pipelineLibpahkat()
  }],
  ["pdf-strings", pipelinePdfStrings],
  ["kielipankki-donatespeech-app", pipelineDonateSpeech],
  ["divvunspell-libreoffice", pipelineLibreOfficeExtension],
  ["subethaedit", pipelineSubethaedit],
  ["giella-core", pipelineDocsData],
])

/** The families of repositories that share a pipeline, by name prefix. */
const REPOSITORY_FAMILY_PIPELINES: [prefix: string, PipelineFactory][] = [
  ["keyboard-", pipelineDesktopKeyboard],
  ["lang-", pipelineLang],
  ["dict-", pipelineDict],
  // No FST/speller build for either family — just the Class-1 badge
  // publish. See pipelines/docsdata/mod.ts.
  ["shared-", pipelineDocsData],
  ["template-", pipelineDocsData],
]

/**
 * The pipeline a repository builds with. A repository named in
 * `REPOSITORY_PIPELINES` gets its own pipeline even when a family's prefix
 * also matches it, as keyboard-viewer does `keyboard-`.
 */
export function repositoryPipeline(
  repoName: string,
): PipelineFactory | undefined {
  const name = repoName.toLowerCase()
  return REPOSITORY_PIPELINES.get(name) ??
    REPOSITORY_FAMILY_PIPELINES.find(([prefix]) => name.startsWith(prefix))
      ?.[1]
}

export async function createCiPipeline(): Promise<BuildkitePipeline> {
  const pipeline = repositoryPipeline(builder.env.repoName)
  if (pipeline == null) {
    throw new Error(`Unknown repo: ${builder.env.repoName}`)
  }
  return securePipelineForContext(await pipeline(), builder.env)
}

async function runCi() {
  logger.info("Running CI")
  await logJobEnvironment()
  const pipeline = await createCiPipeline()
  pipeline.env = {
    ...pipeline.env,
    [BUILD_TIMESTAMP]: builder.env.buildTimestamp,
  }

  // Strip undefined values from pipeline object before YAML serialization
  // JSON.stringify removes undefined properties, then parse reconstructs the clean object
  const input = yaml.stringify(JSON.parse(JSON.stringify(pipeline)))
  using pipelinePath = await makeTempFile({ suffix: ".yml" })

  Deno.writeTextFileSync(pipelinePath.path, input)
  await builder.exec("buildkite-agent", [
    "pipeline",
    "upload",
    pipelinePath.path,
  ])
}
