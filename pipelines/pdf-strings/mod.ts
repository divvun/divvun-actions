import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${target.gitHash}`,
    ],
  }
}

export function pipelinePdfStrings(): BuildkitePipeline {
  const pipeline: BuildkitePipeline = {
    steps: [],
  }

  // Group all wheel build steps
  pipeline.steps.push({
    group: "Build Wheels",
    key: "build-wheels",
    steps: [
      command({
        label: ":python: Build Python Wheel (Linux)",
        key: "wheel-linux",
        agents: {
          queue: "linux",
        },
        command: [
          "cd python",
          "uv build --wheel",
          "cp dist/*.whl .",
          "buildkite-agent artifact upload *.whl",
        ],
      }),
      command({
        label: ":python: Build Python Wheel (macOS)",
        key: "wheel-macos",
        agents: {
          queue: "macos",
        },
        command: [
          "cd python",
          "uv build --wheel",
          "cp dist/*.whl .",
          "buildkite-agent artifact upload *.whl",
        ],
      }),
      command({
        label: ":python: Build Python Wheel (Windows)",
        key: "wheel-windows",
        agents: {
          queue: "windows",
        },
        command: [
          "cd python",
          "uv build --wheel",
          "copy dist\\*.whl .",
          "buildkite-agent artifact upload *.whl",
        ],
      }),
    ],
  })

  // Always run dry-run publish to TestPyPI
  pipeline.steps.push(
    command({
      label: ":package: Publish Wheels (Dry Run)",
      key: "publish-dryrun",
      depends_on: "build-wheels",
      agents: {
        queue: "linux",
      },
      command: [
        "buildkite-agent artifact download '*.whl' .",
        "ls -lah *.whl",
        "uv publish --dry-run --publish-url https://test.pypi.org/legacy/ *.whl",
      ],
    }),
  )

  // If tagged with v*, run real publish to PyPI
  if (builder.env.tag && builder.env.tag.match(/^v/)) {
    pipeline.steps.push(
      command({
        label: ":package: Publish Wheels to PyPI",
        key: "publish-pypi",
        depends_on: "build-wheels",
        agents: {
          queue: "linux",
        },
        command: "divvun-actions run pdf-strings-publish",
      }),
    )
  }

  return pipeline
}

export async function runPdfStringsPublish() {
  const secrets = await builder.secrets()

  await builder.downloadArtifacts("*.whl", ".")

  await builder.exec("ls", ["-lah", "*.whl"])

  await builder.exec("uv", ["publish", "*.whl"], {
    env: {
      UV_PUBLISH_TOKEN: secrets.get("pypiToken"),
    },
  })
}
