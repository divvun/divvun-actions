# Linux build agents as Firecracker microVMs

Each Linux build host runs a fixed set of **slots**. A slot boots a
Firecracker microVM, the VM's Buildkite agent takes one job
(`--disconnect-after-job`), and when it is done the VM is thrown away and
the slot boots a new one. Every job starts from a clean root filesystem,
gets its own kernel, and can run a real `dockerd`, so sysbox is not needed.

Windows agents stay on Docker (`docker/update.ps1`): Firecracker only runs
Linux guests, on Linux KVM hosts.

## How it fits together

```
docker/images/*.ts ──generate──▶ Dockerfile.{linux,alpine} ──CI──▶ ghcr.io/…:ubuntu-latest
firecracker/kernel/ ─────────────────────────────────────CI──▶ ghcr.io/…:fc-kernel-latest
                                                                       │
 host: divvun-fc-images.timer ── crane export | mkfs.erofs ◀───────────┘
                                   └▶ /var/lib/divvun-fc/images/<repo>/<digest>/rootfs.erofs
                                      /var/lib/divvun-fc/kernel/<digest>/vmlinux
 host: divvun-fc@<slot>.service ── jailer ─▶ firecracker ─▶ guest
```

- **The images stay the Docker images.** `docker/images/*.ts` remains the
  one definition, CI still builds and pushes them, and they still run under
  Docker for local work. Each also carries `docker/vm-init.sh` as
  `/usr/local/sbin/divvun-vm-init`, which only does anything when it is
  PID 1 of a VM.
- **The host converts each new digest once.** `images update` resolves each
  pool's image ref and the kernel ref to a digest. When the digest is new,
  it streams the flattened image through `mkfs.erofs --tar=f` into a
  read-only root filesystem. It saves the image config's `ENV`, which
  Docker would otherwise have set, and loop-mounts the result to check that
  it can boot. Then it repoints `current`. It keeps the previous version
  too.
- **The kernel** is Amazon Linux's `microvm-kernel-*` tree, built with
  Firecracker's own guest config for that series. That is the combination
  Firecracker validates. `kernel/divvun.config` adds what Docker, erofs and
  `SendCtrlAltDel` need, and the build fails if any of it gets dropped.
  Versions are pinned in `versions.ts`.
- **Every boot** gets these drives:

  | Drive          | Contents                                                                 | Lifetime           |
  | -------------- | ------------------------------------------------------------------------ | ------------------ |
  | `rootfs.erofs` | the image, read-only (hard link)                                         | shared             |
  | `scratch.ext4` | overlayfs upper layer over the image                                     | one job            |
  | `cache.ext4`   | builds, plugins, fs-cache, docker, containerd, cargo, gradle, `~/.cache` | per slot, kept     |
  | `config.ext4`  | agent env, image `ENV`, hooks, secrets, docker `config.json`             | one job, read-only |

  The guest finds them by ext4 label. Paths inside the guest match the old
  containers: `/buildkite/builds`, `/buildkite/hooks`, `/buildkite-secrets`,
  `/var/cache/buildkite`.
- **Networking:** slot _n_ gets a tap `fctap<n>` and the _n_th /30 of
  `network.subnet`. The kernel configures the guest's address from `ip=`,
  so the guest runs no DHCP. The host NATs the guests out. Guests cannot
  reach each other, and cannot open connections to the host itself.
- **Isolation:** Firecracker runs under the jailer, chrooted, with its own
  uid per slot (`uid_base + n`). It stays in the systemd unit's cgroup.
  Memory and CPUs are bounded by the VM's own size.

## Rolling out a new image

There is nothing to drain. The timer converts a new release within five
minutes. Each slot boots its next VM from it once its current job ends.
Running jobs keep the image they booted with, because their jail holds a
hard link to it.

By default a slot's cache disk starts over when its pool's image changes,
just as the containers lost their state when they were recreated. Set
`cache.reset_on_image_change = false` to keep it. The cache disk also starts
over when it is more than `cache.reset_usage` full at boot, when its
configured size changes, or when `e2fsck` cannot repair it.

To hold a pool on a known-good image, pin its digest:
`image = "ghcr.io/divvun/divvun-actions:ubuntu-latest@sha256:…"`.

To try an image before releasing it, push it under another tag and point one
pool at that tag.

## Setting up a host

Requirements: x86_64, `/dev/kvm`, a systemd-based distro with cgroup v2, and
apt for the automatic package install (Ubuntu 24.04 is what this targets).
The host kernel needs erofs, which Ubuntu's kernel ships as a module, for
the boot check.

```sh
git clone https://github.com/divvun/divvun-actions /opt/divvun-actions
cd /opt/divvun-actions
curl -fsSL https://deno.land/install.sh | sudo DENO_INSTALL=/usr/local sh -s -- -y
sudo deno task fc setup          # apt deps, pinned firecracker/jailer/crane, example config
sudoedit /etc/divvun-fc/config.toml
echo -n "$BUILDKITE_AGENT_TOKEN" | sudo install -m 600 /dev/stdin /etc/divvun-fc/agent-token
sudo deno task fc install        # systemd units, one divvun-fc@<slot> per slot
sudo deno task fc status
```

If the ghcr packages are private, run `sudo crane auth login ghcr.io` once.
To push images from jobs, write a Docker `config.json` holding the
credentials, and point `buildkite.docker_config` at it.

`install` is idempotent. Run it again after editing the config. It
enables new slots, and stops slots that were removed once their jobs
finish.

## Operating

|                                |                                                    |
| ------------------------------ | -------------------------------------------------- |
| Logs (agent and guest console) | `journalctl -u divvun-fc@linux-1 -f`               |
| Image conversions              | `journalctl -u divvun-fc-images`                   |
| Convert now                    | `sudo systemctl start divvun-fc-images`            |
| Stop a slot after its job      | `sudo systemctl stop divvun-fc@linux-1`            |
| Stop it now, killing the job   | `sudo systemctl kill -s SIGKILL divvun-fc@linux-1` |
| Empty a slot's cache           | `sudo deno task fc slot reset-cache linux-1`       |
| See the whole kernel boot      | `kernel.extra_args = ""`, then restart the slot    |

A guest that cannot start (a bad image, `dockerd` not coming up, the agent
failing to register) waits 60 seconds before it resets, so a broken release
shows up as slots repeatedly logging the failure, not as a tight boot loop.
The host backs off the same way when Firecracker itself fails.

Jobs log the slot, host, image digest and kernel digest they ran on, under
"MicroVM:" in the Environment group.

## Moving a host off the Docker containers

Run both side by side for a while if you like. The Firecracker firewall lets
VM traffic through Docker's `DOCKER-USER` chain. Then remove the
`update-cron.sh` crontab entry and the `builder-*` containers.

Things that worked by accident in long-lived containers and need a home now:

- **Registry logins.** No pipeline runs `docker login`. Whatever logged the
  containers in to ghcr has to become `buildkite.docker_config` or a hook.
- **Anything installed by hand inside a container.** It must go into
  `docker/images/*.ts`.
- **Host firewalls.** A ufw or other default-drop FORWARD policy has to
  allow `fctap+`.
