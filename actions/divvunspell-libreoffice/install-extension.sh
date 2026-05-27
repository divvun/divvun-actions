#!/bin/bash
# Register or deregister the divvunspell-libreoffice .oxt against every
# LibreOffice install discovered on the system.
#
# Usage:
#   install-extension.sh add    <path-to-oxt>
#   install-extension.sh remove <extension-id>
#
# Exits 0 even if no LibreOffice is found, so a missing LibreOffice does not
# fail the surrounding installer hook. Per-install failures are logged but
# do not abort the loop — partial success is preferable to an aborted install.

set -u

if [ $# -ne 2 ]; then
    echo "Usage: $0 <add|remove> <target>" >&2
    exit 2
fi

action="$1"
target="$2"

case "$action" in
    add|remove) ;;
    *)
        echo "Unknown action: $action" >&2
        exit 2
        ;;
esac

find_unopkgs() {
    local roots=(
        "/Applications"
        "$HOME/Applications"
    )
    for root in "${roots[@]}"; do
        [ -d "$root" ] || continue
        find "$root" -maxdepth 4 -path "*/LibreOffice*.app/Contents/MacOS/unopkg" 2>/dev/null
    done
}

extra_args=()
if [ "$action" = "add" ]; then
    extra_args+=("--suppress-license")
fi

found_any=false
while IFS= read -r unopkg; do
    [ -n "$unopkg" ] || continue
    found_any=true
    echo "[divvunspell-libreoffice] $action via $unopkg"
    if ! "$unopkg" "$action" --shared "${extra_args[@]}" "$target"; then
        echo "[divvunspell-libreoffice] $unopkg failed (continuing)"
    fi
done < <(find_unopkgs)

if [ "$found_any" = false ]; then
    echo "[divvunspell-libreoffice] No LibreOffice installation found; skipping."
fi

exit 0
