#!/bin/bash
# PID 1 of a Firecracker microVM booted from this image (see firecracker/).
#
# One boot runs one Buildkite job: the agent starts with
# --disconnect-after-job, and when it exits the VM resets, which makes
# Firecracker exit, and the host boots a fresh VM for the next job.
#
# The kernel mounts the image itself, an erofs, read-only as /. The other
# drives are ext4, found by label (DRIVE_LABELS in firecracker/host/vm.ts):
#   divvun-scratch  empty every boot: the writable layer over /
#   divvun-cache    kept between boots: builds, docker, tool caches
#   divvun-config   read-only: env, image-env, microvm, hooks/, secrets/,
#                   docker-config.json

set -eEuo pipefail

SELF=/usr/local/sbin/divvun-vm-init
CONFIG=/run/divvun-fc/config

# <cache-subdir>:<mountpoint>. The mountpoints match where the long-lived
# containers kept this state, so jobs see the same paths.
CACHE_DIRS=(
  builds:/buildkite/builds
  plugins:/buildkite/plugins
  fs-cache:/var/cache/buildkite
  docker:/var/lib/docker
  containerd:/var/lib/containerd
  home-cache:/root/.cache
  cargo-registry:/root/.cargo/registry
  cargo-git:/root/.cargo/git
  gradle:/root/.gradle
)

log() {
  echo "divvun-vm-init: $*" >&2
}

reset_vm() {
  sync
  echo 1 >/proc/sys/kernel/sysrq
  echo b >/proc/sysrq-trigger
}

# A broken image or bad token would otherwise make the host boot VMs in a
# tight loop. If this fails too, PID 1 exits and panic=1 resets the VM.
fail() {
  trap - ERR
  log "failed: $*; resetting in 60s"
  sleep 60
  reset_vm
}

# The kernel's root is the read-only erofs. Put an overlay over it with the
# scratch disk as the upper layer, and pivot into that.
stage1() {
  trap 'fail "stage1 line $LINENO"' ERR
  # For mount to find the drive by label.
  mount -t proc proc /proc

  mount -t tmpfs -o mode=0755 tmpfs /mnt
  mkdir /mnt/scratch /mnt/root
  mount -t ext4 -o discard LABEL=divvun-scratch /mnt/scratch
  mkdir /mnt/scratch/upper /mnt/scratch/work
  mount -t overlay overlay \
    -o lowerdir=/,upperdir=/mnt/scratch/upper,workdir=/mnt/scratch/work \
    /mnt/root
  mount -t devtmpfs devtmpfs /mnt/root/dev

  cd /mnt/root
  mkdir -p oldroot
  pivot_root . oldroot
  # The console is a terminal, so reading and writing it is fine.
  # shellcheck disable=SC2094
  exec chroot . "$SELF" stage2 <dev/console >dev/console 2>&1
}

stage2() {
  trap 'fail "stage2 line $LINENO"' ERR
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

  mount -t proc proc /proc
  mount -t sysfs sysfs /sys
  mount -t cgroup2 cgroup2 /sys/fs/cgroup
  mkdir -p /dev/pts /dev/shm
  mount -t devpts -o gid=5,mode=620,ptmxmode=666 devpts /dev/pts
  mount -t tmpfs -o mode=1777 shm /dev/shm
  mount -t tmpfs -o mode=0755 tmpfs /run
  ln -sfn /proc/self/fd /dev/fd
  ln -sfn /proc/self/fd/0 /dev/stdin
  ln -sfn /proc/self/fd/1 /dev/stdout
  ln -sfn /proc/self/fd/2 /dev/stderr
  umount -l /oldroot
  rmdir /oldroot

  local controller
  for controller in cpu cpuset io memory pids; do
    echo "+$controller" >/sys/fs/cgroup/cgroup.subtree_control 2>/dev/null ||
      log "cgroup controller $controller unavailable"
  done

  # The kernel set the address, gateway, hostname and nameservers from ip=.
  # An image may ship these as symlinks into /run, which is a fresh tmpfs.
  local name
  name=$(</proc/sys/kernel/hostname)
  rm -f /etc/hostname /etc/hosts /etc/resolv.conf
  echo "$name" >/etc/hostname
  printf '127.0.0.1 localhost\n::1 localhost\n127.0.1.1 %s\n' "$name" >/etc/hosts
  grep '^nameserver' /proc/net/pnp >/etc/resolv.conf

  local tini
  tini=$(command -v tini || echo /usr/bin/docker-init)
  exec "$tini" -- "$SELF" run
}

# The host sends Ctrl-Alt-Del, which the kernel turns into SIGINT for tini
# and tini passes on to run(), and keeps sending it until the VM is gone. A
# second SIGTERM would make the agent cancel its job, so it gets one.
STOP_REQUESTED=""
AGENT_PID=""
AGENT_SIGNALLED=""

signal_agent() {
  if [[ -n "$AGENT_PID" && -z "$AGENT_SIGNALLED" ]]; then
    AGENT_SIGNALLED=1
    log "asked to stop; the agent finishes its job first"
    kill -TERM "$AGENT_PID" 2>/dev/null || true
  fi
}

stop_job() {
  STOP_REQUESTED=1
  signal_agent
}

run() {
  trap 'fail "run line $LINENO"' ERR
  trap stop_job INT TERM

  mkdir -p "$CONFIG" /cache
  mount -t ext4 -o ro LABEL=divvun-config "$CONFIG"
  mount -t ext4 -o discard LABEL=divvun-cache /cache

  set -a
  # shellcheck source=/dev/null
  . "$CONFIG/image-env"
  # shellcheck source=/dev/null
  . "$CONFIG/env"
  set +a
  export HOME=/root USER=root

  local pair src dst
  for pair in "${CACHE_DIRS[@]}"; do
    src="/cache/${pair%%:*}"
    dst="${pair#*:}"
    mkdir -p "$src" "$dst"
    mount -o bind "$src" "$dst"
  done
  mkdir -p /buildkite/hooks /buildkite-secrets
  mount -o bind "$CONFIG/hooks" /buildkite/hooks
  mount -o bind "$CONFIG/secrets" /buildkite-secrets
  if [[ -f "$CONFIG/docker-config.json" ]]; then
    install -D -m 600 "$CONFIG/docker-config.json" /root/.docker/config.json
  fi
  install -D -m 644 "$CONFIG/microvm" /etc/divvun-actions/microvm

  # Docker's default for containers; PID 1's inherited 1024 is too few for
  # some builds.
  ulimit -n 1048576 2>/dev/null || log "could not raise the open file limit"

  local dockerd_pid=""
  if command -v dockerd >/dev/null; then
    dockerd --host unix:///var/run/docker.sock >>/var/log/dockerd.log 2>&1 &
    dockerd_pid=$!
    local tries=0
    until docker info >/dev/null 2>&1; do
      tries=$((tries + 1))
      if [[ $tries -ge 60 ]]; then
        tail -n 50 /var/log/dockerd.log >&2 || true
        fail "dockerd did not come up in 60s"
      fi
      sleep 1
    done
  fi

  local status=0
  if [[ -n "$STOP_REQUESTED" ]]; then
    log "asked to stop before the agent started"
  else
    buildkite-agent start --disconnect-after-job --tags-from-host &
    AGENT_PID=$!
    if [[ -n "$STOP_REQUESTED" ]]; then
      signal_agent
    fi
    while kill -0 "$AGENT_PID" 2>/dev/null; do
      wait "$AGENT_PID" && status=0 || status=$?
    done
  fi

  if [[ -n "$dockerd_pid" ]]; then
    kill -TERM "$dockerd_pid" 2>/dev/null || true
    local waited=0
    while kill -0 "$dockerd_pid" 2>/dev/null && [[ $waited -lt 20 ]]; do
      sleep 1
      waited=$((waited + 1))
    done
  fi
  # Linux leaves the caller out of kill(-1), and tini is PID 1.
  kill -TERM -1 2>/dev/null || true
  sleep 2
  kill -KILL -1 2>/dev/null || true
  sync
  mount -o remount,ro /cache || log "could not remount /cache read-only"

  if [[ $status -ne 0 ]]; then
    fail "buildkite-agent exited with $status"
  fi
  log "done, resetting"
  reset_vm
}

case "${1:-stage1}" in
stage1) stage1 ;;
stage2) stage2 ;;
run) run ;;
*)
  log "unknown stage: $1"
  exit 1
  ;;
esac
