# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

divvun-actions is a Buildkite plugin (`plugin.yml`, `hooks/`). Its `environment` hook puts `bin/` on the agent's `PATH`, and pipeline steps call `divvun-actions`, which runs `main.ts` with Deno on the agent itself. Almost all of it runs only inside a Buildkite job: `builder.ts` refuses to load unless `BUILDKITE` is set, and so does everything that imports it.

## Commands

- **Type-check**: `deno check`, with no arguments
- **Lint**: `deno lint`
- **Format**: `deno fmt`
- **Test**: `deno test -A`. Tests are `*_test.ts` files beside the code they cover. Code that imports `~/builder.ts` needs `BUILDKITE` and `BUILDKITE_REPO` set first, so tests set them and then use `await import(...)`.
- **Agent images**: `deno task docker:gen` regenerates the Dockerfiles in `docker/`, `docker:check` fails if they are stale, `docker:list` lists the images, and `docker:audit` compares the pinned tool versions in `docker/versions.ts` with the latest upstream releases.

## CLI

The command line is parsed with `@optique`. `main.ts` picks one of two CLIs by `isBuildkiteJob()` (`util/env.ts`), and `--help` lists what the chosen one offers:

- `cli_local.ts`, outside a Buildkite job: only `localCommands`, the commands that run anywhere. Nothing it imports may import `~/builder.ts`. `run`, `ci` and `sign` fail there with a message that they need a Buildkite job.
- `cli.ts`, in a Buildkite job: `localCommands` plus the commands below, one for each name in `BUILDKITE_COMMANDS`.

The command that runs anywhere:

- `divvun-actions trigger <regex>` starts a build of each unarchived Buildkite pipeline whose slug matches, at the head of its default branch or of `--branch`. It lists them and asks first, unless given `--yes`; `--dry-run` only lists them. It reads an API access token with the `read_pipelines` and `write_builds` scopes from `BUILDKITE_API_TOKEN`, or else from `~/.buildkite-token` (`services/trigger-builds/`).

The commands that only run in a Buildkite job:

- `divvun-actions ci` chooses the repository's pipeline by name, first in `REPOSITORY_PIPELINES` and then by the `lang-`, `dict-`, `keyboard-`, `shared-` and `template-` families in `REPOSITORY_FAMILY_PIPELINES`. It drops privileged steps when the build is untrusted, then uploads the pipeline with `buildkite-agent pipeline upload`.
- `divvun-actions run <action> [args]` runs one step of a pipeline. The actions are a table in `cli.ts`, grouped by family. `cli_test.ts` lists every command line the pipelines generate and checks that each still parses, so update it when a step's command changes.
- `divvun-actions sign <file> [true|false]` signs a Windows executable. Inno Setup (`actions/inno-setup/build.cmd`) and outto call it as their sign tool; `true` leaves the file unsigned.

## Layout

- `pipelines/`: one module per repository or family of repositories. Each has a `pipeline*()` function that generates its Buildkite steps, plus the `run*()` functions those steps call through `divvun-actions run`.
- `actions/`: the building blocks the pipelines use: bundling, installers (Inno Setup, outto), signing, deploys, Pahkat publishing.
- `builder.ts` and `builder/buildkite/`: the job's environment (`builder.env`), running commands, artifacts, metadata and secrets.
- `util/`: shared helpers.
- `services/`: `macos-codesign.ts` (rcodesign and notarisation) and `windows-codesign.ts`. `sync-github/` is a standalone CLI that compares GitHub repositories with their Buildkite pipelines and syncs them, and holds the Buildkite API client. `trigger-builds/` is what `divvun-actions trigger` runs.
- `docker/`: the agent images (alpine, linux, windows-vsbase, windows), generated from `docker/images/*.ts` and `docker/versions.ts`. The divvun-actions pipeline builds and pushes them.
- `hooks/` and `bin/`: the plugin's hooks, and the `divvun-actions` wrappers the hooks put on `PATH`.

## Agents

Steps choose an agent with a `queue`: `linux`, `macos`, `windows` or `alpine`. Linux agents are single-use Firecracker microVMs run by arsonist (necessary-nu/arsonist), not by code in this repository; divvun-actions only reads `/run/arsonist/vm.json` for the job log (`util/job_environment.ts`). Windows agents run in Docker.

## Security

- `util/trusted_context.ts` decides whether a build is a trusted release context. That needs a trusted GitHub repository, and either a release tag matching `TRUSTED_RELEASE_TAG` or a non-pull-request build of `main` (for kbdgen and kbdi, `main` or `v4`). Buildkite's secret-access policies remain the outer boundary.
- `util/privileged_action.ts` defines the privileged actions: deploy, publish, bump-manifest, signing, `divvun-actions-build-image … push`, and the builds that need secrets. `ci` drops them from untrusted builds' pipelines, and `run` refuses them in an untrusted build.
- Secrets come from OpenBao (`util/openbao.ts`) and are redacted from the log.
