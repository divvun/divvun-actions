#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

target="${1:-}"
if [ -z "$target" ]; then
  echo "usage: $0 <target>     # e.g. alpine, linux" >&2
  echo "       $0 --list       # show available targets" >&2
  exit 1
fi

if [ "$target" = "--list" ] || [ "$target" = "-l" ]; then
  exec deno run --allow-read --allow-env generate.ts --list
fi

deno run --allow-read --allow-write --allow-env generate.ts --only="$target"
ref=$(deno run --allow-read --allow-env generate.ts --print-ref="$target")

exec docker build --platform linux/amd64 -t "$ref" -f "Dockerfile.$target" .
