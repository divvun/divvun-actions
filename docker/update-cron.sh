#!/usr/bin/env bash

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPDATE_SCRIPT="$SCRIPT_DIR/update.sh"
CONFIG_FILE="${CONFIG_FILE:-$SCRIPT_DIR/config-standard.env}"
LOCK_FILE="/tmp/docker-update.lock"
LOG_FILE="/var/log/docker-update.log"

# Ensure log file exists and is writable
if [[ ! -f "$LOG_FILE" ]]; then
    sudo touch "$LOG_FILE"
    sudo chmod 666 "$LOG_FILE"
fi

# Function to log with timestamp
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# Function to cleanup on exit
cleanup() {
    if [[ -f "$LOCK_FILE" ]]; then
        rm -f "$LOCK_FILE"
    fi
}
trap cleanup EXIT

# Check if update script exists
if [[ ! -f "$UPDATE_SCRIPT" ]]; then
    log "ERROR: Update script not found at $UPDATE_SCRIPT"
    exit 1
fi

# Load configuration file if it exists
if [[ -f "$CONFIG_FILE" ]]; then
    log "Loading configuration from $CONFIG_FILE"
    source "$CONFIG_FILE"
else
    log "WARNING: Configuration file not found at $CONFIG_FILE, using defaults"
fi

# Check for lock file to prevent concurrent runs
if [[ -f "$LOCK_FILE" ]]; then
    # Check if the process is still running
    if kill -0 "$(cat "$LOCK_FILE")" 2>/dev/null; then
        log "Update already in progress (PID: $(cat "$LOCK_FILE")). Skipping."
        exit 0
    else
        log "Stale lock file found, removing..."
        rm -f "$LOCK_FILE"
    fi
fi

# Create lock file
echo $$ > "$LOCK_FILE"

# Check if BUILDKITE_AGENT_TOKEN is set
if [[ -z "${BUILDKITE_AGENT_TOKEN:-}" ]]; then
    log "ERROR: BUILDKITE_AGENT_TOKEN environment variable is required"
    exit 1
fi

log "Starting Docker update check..."

# Export environment variables for the update script
export BUILDKITE_AGENT_TOKEN
export INSTANCE_COUNT="${INSTANCE_COUNT:-4}"
export CONTAINER_PREFIX="${CONTAINER_PREFIX:-builder-}"
export QUEUE_TAGS="${QUEUE_TAGS:-queue=linux}"
export MEMORY_RESERVATION="${MEMORY_RESERVATION:-6g}"
export MEMORY_LIMIT="${MEMORY_LIMIT:-24g}"

# Run the update script and capture output
if "$UPDATE_SCRIPT" 2>&1 | while IFS= read -r line; do
    log "UPDATE: $line"
done; then
    log "Update check completed successfully"
else
    exit_code=$?
    log "Update check failed with exit code: $exit_code"
    exit $exit_code
fi

# Log rotation: keep last 1000 lines
if [[ -f "$LOG_FILE" ]]; then
    tail -n 1000 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi