#!/usr/bin/env bash
# Installed as /usr/local/bin/clang, ahead of the real /usr/bin/clang.
#
# cargo-xwin passes clang-cl style "/imsvc DIR" include flags to every C
# compiler through CFLAGS_<target>. ring's build script drives the plain clang
# driver for aarch64-pc-windows-msvc, which rejects them, so each pair becomes
# the driver's "-isystem DIR". Every other invocation passes through unchanged.
#
# Clang picks its driver mode (clang, clang++, clang-cl) from argv[0], so the
# real binary gets the name this script was invoked by: a clang-cl symlink to
# it, such as the one cargo-xwin makes in its cache, stays in cl mode.
args=()
while (($#)); do
  if [[ $1 == /imsvc && $# -ge 2 ]]; then
    args+=(-isystem "$2")
    shift 2
  else
    args+=("$1")
    shift
  fi
done
exec -a "$0" /usr/bin/clang "${args[@]}"
