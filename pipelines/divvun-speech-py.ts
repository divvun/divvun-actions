import * as path from "@std/path"
import * as toml from "@std/toml"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { makeTempDir } from "~/util/temp.ts"

const MODEL_CONFIG = "ci/model.toml"
const PIPELINE_CONFIG = "ci/pipeline.json"
const CHECKPOINT_URL_ENV = "DIVVUN_SPEECH_CHECKPOINT_URL"

type ModelConfig = {
  version: number
  checkpoint_name: string
  checkpoint_sha256: string
  alphabet: string
  backends: string[]
  vocoder: string
  split: boolean
}

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${targetModule.gitHash}`,
    ],
  }
}

export function pipelineDivvunSpeechPy(): BuildkitePipeline {
  return {
    steps: [
      command({
        key: "python-package",
        label: ":python: Check locked exporter",
        agents: { queue: "linux" },
        command: [
          "uv lock --check",
          "uv build --wheel",
          "buildkite-agent artifact upload 'dist/*.whl'",
        ],
      }),
      command({
        key: "export-multi-sami",
        label: ":speaker: Export multi-Sámi ExecuTorch bundle",
        agents: { queue: "linux", size: "large" },
        depends_on: "python-package",
        // The checkpoint is intentionally not stored in Git. Once its signed
        // URL is configured on the Buildkite pipeline, every build can export;
        // without it, package/lock CI still runs instead of failing all PRs.
        if: `build.env("${CHECKPOINT_URL_ENV}") != null`,
        command: "divvun-actions run divvun-speech-py-export",
      }),
    ],
  }
}

async function readModelConfig(): Promise<ModelConfig> {
  const value = toml.parse(await Deno.readTextFile(MODEL_CONFIG)) as ModelConfig
  if (
    value.version !== 1 || value.checkpoint_name.length === 0 ||
    !/^[0-9a-f]{64}$/.test(value.checkpoint_sha256) ||
    value.alphabet.length === 0 || value.backends.length === 0 ||
    value.vocoder.length === 0 || value.split !== true
  ) {
    throw new Error(`Invalid ${MODEL_CONFIG}`)
  }
  return value
}

async function sha256(file: string): Promise<string> {
  const result = await builder.output("sha256sum", [file])
  if (!result.status.success) {
    throw new Error(`sha256sum failed for ${file}: ${result.stderr.trim()}`)
  }
  return result.stdout.trim().split(/\s+/, 1)[0]
}

async function requireFile(file: string): Promise<void> {
  const stat = await Deno.stat(file)
  if (!stat.isFile || stat.size === 0) {
    throw new Error(`Expected a non-empty file at ${file}`)
  }
}

export async function runDivvunSpeechPyExport() {
  const config = await readModelConfig()
  const checkpointUrl = Deno.env.get(CHECKPOINT_URL_ENV)
  if (!checkpointUrl) {
    throw new Error(`${CHECKPOINT_URL_ENV} is required to export the model`)
  }
  await builder.redactSecret(checkpointUrl)

  using work = await makeTempDir({ prefix: "divvun-speech-export-" })
  const input = path.join(work.path, "input")
  const output = path.join(work.path, "output")
  const bundle = path.join(work.path, "bundle")
  await Promise.all([
    Deno.mkdir(input),
    Deno.mkdir(output),
    Deno.mkdir(bundle),
  ])

  const checkpoint = path.join(input, config.checkpoint_name)
  await builder.exec("curl", [
    "--fail",
    "--location",
    "--retry",
    "3",
    "--output",
    checkpoint,
    checkpointUrl,
  ])
  const actualCheckpointHash = await sha256(checkpoint)
  if (actualCheckpointHash !== config.checkpoint_sha256) {
    throw new Error(
      `Checkpoint checksum mismatch: expected ${config.checkpoint_sha256}, ` +
        `got ${actualCheckpointHash}`,
    )
  }

  await builder.exec("uv", [
    "sync",
    "--frozen",
    "--extra",
    "executorch-export",
    "--no-dev",
  ])
  const python = path.resolve(".venv/bin/python")
  await builder.exec(python, [
    "divvun_speech/export_toolchain.py",
    "verify-environment",
  ])

  const symbols = await builder.output(python, [
    "-c",
    `from divvun_speech.common.text.symbols import get_symbols; print(len(get_symbols(${
      JSON.stringify(config.alphabet)
    })))`,
  ])
  if (!symbols.status.success || symbols.stdout.trim() !== "92") {
    throw new Error(
      `Expected the ${config.alphabet} alphabet to contain 92 symbols; ` +
        `got ${symbols.stdout.trim() || symbols.stderr.trim()}`,
    )
  }

  const univnet = path.join(input, "tts_en_libritts_multispeaker_univnet.nemo")
  await builder.exec(python, [
    "divvun_speech/export_toolchain.py",
    "download-univnet",
    univnet,
  ])

  const exportArgs = [
    "-m",
    "divvun_speech.compile_executorch",
    checkpoint,
    univnet,
    config.alphabet,
    "--backends",
    config.backends.join(","),
    "--vocoder",
    config.vocoder,
  ]
  if (config.split) exportArgs.push("--split")
  await builder.exec(python, exportArgs, { cwd: output })

  const voice = path.join(output, "voice_split_xnnpack.pte")
  const vocoder = path.join(output, "vocoder_dyn_xnnpack.pte")
  await Promise.all([requireFile(voice), requireFile(vocoder)])

  await Promise.all([
    Deno.copyFile(PIPELINE_CONFIG, path.join(bundle, "pipeline.json")),
    Deno.copyFile(voice, path.join(bundle, "voice_xnnpack.pte")),
    Deno.copyFile(vocoder, path.join(bundle, "vocoder_xnnpack.pte")),
  ])

  const archive = path.join(work.path, "tts.drb")
  await builder.exec("box", [
    "create",
    "--stored",
    archive,
    "pipeline.json",
    "voice_xnnpack.pte",
    "vocoder_xnnpack.pte",
  ], { cwd: bundle })
  await builder.exec("box", ["validate", archive])

  const lockHash = await sha256("uv.lock")
  const provenance = {
    version: 1,
    source_commit: builder.env.commit,
    checkpoint: {
      name: config.checkpoint_name,
      sha256: actualCheckpointHash,
    },
    exporter_lock_sha256: lockHash,
    alphabet: config.alphabet,
    backends: config.backends,
    split: config.split,
    artifacts: {
      voice_xnnpack_pte_sha256: await sha256(voice),
      vocoder_xnnpack_pte_sha256: await sha256(vocoder),
      tts_drb_sha256: await sha256(archive),
    },
  }
  const provenancePath = path.join(work.path, "tts-build.json")
  await Deno.writeTextFile(
    provenancePath,
    JSON.stringify(provenance, null, 2) + "\n",
  )

  await Promise.all([
    builder.uploadArtifacts(archive),
    builder.uploadArtifacts(provenancePath),
  ])
}
