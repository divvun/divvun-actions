#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRON_SCRIPT="$SCRIPT_DIR/update-cron.sh"

# Check if BUILDKITE_AGENT_TOKEN is set
if [[ -z "${BUILDKITE_AGENT_TOKEN:-}" ]]; then
    echo "ERROR: BUILDKITE_AGENT_TOKEN environment variable must be set"
    echo "Example: export BUILDKITE_AGENT_TOKEN='your-token-here'"
    exit 1
fi

echo "Setting up cron job for Docker container updates..."
echo "Script location: $CRON_SCRIPT"

# Create crontab entry
CRON_ENTRY="* * * * * BUILDKITE_AGENT_TOKEN='$BUILDKITE_AGENT_TOKEN' $CRON_SCRIPT"

# Add to crontab (preserving existing entries)
if crontab -l 2>/dev/null | grep -F "$CRON_SCRIPT" >/dev/null; then
    echo "Cron job already exists. Updating..."
    # Remove old entry and add new one
    crontab -l 2>/dev/null | grep -v -F "$CRON_SCRIPT" | { cat; echo "$CRON_ENTRY"; } | crontab -
else
    echo "Adding new cron job..."
    # Add new entry to existing crontab
    (crontab -l 2>/dev/null; echo "$CRON_ENTRY") | crontab -
fi

echo "Cron job installed successfully!"
echo "The update script will now run every minute to check for new Docker images."
echo ""
echo "To view logs: tail -f /var/log/docker-update.log"
echo "To remove cron job: crontab -e (and delete the line with $CRON_SCRIPT)"
echo ""
echo "Current crontab:"
crontab -l