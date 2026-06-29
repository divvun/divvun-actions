#!/bin/bash
# Register or deregister the divvunspell-libreoffice .oxt for the console
# user's LibreOffice profile using oxtreg (no unopkg, no LibreOffice tooling).
#
# Usage:
#   install-extension.sh add    <path-to-oxt>
#   install-extension.sh remove <extension-id>
#
# outto runs this from the installer's after_install / before_uninstall hook
# as root. oxtreg writes the per-user extension cache, so we drop to the
# console user (the human at the machine). Exits 0 when there is no console
# user so a headless/CI install does not fail the surrounding hook.

set -u

if [ $# -ne 2 ]; then
    echo "Usage: $0 <add|remove> <target>" >&2
    exit 2
fi

action="$1"
target="$2"
here="$(cd "$(dirname "$0")" && pwd)"
oxtreg="$here/oxtreg"

case "$action" in
    add)    subcommand="install" ;;
    remove) subcommand="uninstall" ;;
    *)
        echo "Unknown action: $action" >&2
        exit 2
        ;;
esac

if [ ! -x "$oxtreg" ]; then
    echo "[divvunspell-libreoffice] oxtreg not found at $oxtreg" >&2
    exit 1
fi

console_user="$(stat -f%Su /dev/console 2>/dev/null)"
if [ -z "$console_user" ] || [ "$console_user" = "root" ]; then
    echo "[divvunspell-libreoffice] No console user; skipping $subcommand." >&2
    exit 0
fi

echo "[divvunspell-libreoffice] $subcommand for $console_user via oxtreg"
if ! sudo -u "$console_user" -H "$oxtreg" "$subcommand" "$target"; then
    echo "[divvunspell-libreoffice] oxtreg $subcommand failed for $console_user" >&2
    exit 1
fi

exit 0
