#!/usr/bin/env bash

set -euo pipefail

# Parse command line arguments
FORCE_UPDATE=false
while [[ $# -gt 0 ]]; do
    case $1 in
        -f|--force)
            FORCE_UPDATE=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Pulls the image, keeps the local one instead if it was built later, and"
            echo "recreates every container that is missing or runs a different image."
            echo ""
            echo "Options:"
            echo "  -f, --force    Recreate every container, even those already on the image"
            echo "  -h, --help     Show this help message"
            echo ""
            echo "Environment Variables:"
            echo "  BUILDKITE_AGENT_TOKEN    Required: Buildkite agent token"
            echo "  INSTANCE_COUNT           Number of builder instances (default: 4)"
            echo "  CONTAINER_PREFIX         Container name prefix (default: 'builder-')"
            echo "  QUEUE_TAGS               Buildkite queue tags (default: 'queue=linux')"
            echo "  MEMORY_RESERVATION       Memory reservation per container (default: 6g)"
            echo "  MEMORY_LIMIT             Memory limit per container (default: 24g)"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Configuration with defaults
INSTANCE_COUNT=${INSTANCE_COUNT:-4}
MEMORY_RESERVATION=${MEMORY_RESERVATION:-6g}
MEMORY_LIMIT=${MEMORY_LIMIT:-24g}
CONTAINER_PREFIX=${CONTAINER_PREFIX:-"builder-"}
QUEUE_TAGS=${QUEUE_TAGS:-"queue=linux"}
IMAGE_NAME="ghcr.io/divvun/divvun-actions:ubuntu-latest"

# Check required environment variables
if [[ -z "${BUILDKITE_AGENT_TOKEN:-}" ]]; then
    echo "Error: BUILDKITE_AGENT_TOKEN environment variable is required"
    exit 1
fi

echo "Configuration:"
echo "  Instance Count: $INSTANCE_COUNT"
echo "  Container Prefix: $CONTAINER_PREFIX"
echo "  Queue Tags: $QUEUE_TAGS"
echo "  Memory Reservation: $MEMORY_RESERVATION"
echo "  Memory Limit: $MEMORY_LIMIT"
echo "  Image: $IMAGE_NAME"
echo "  Force Update: $FORCE_UPDATE"
echo ""

# Seconds since the epoch at which an image was built.
image_created_epoch() {
    local created
    created=$(docker image inspect "$1" --format '{{.Created}}') || return 1
    date -d "$created" +%s
}

# Note the local image before pulling: `docker pull` moves the tag to whatever
# the registry has, even when that is older than an image built on this host.
echo "Checking current image..."
LOCAL_IMAGE_ID=""
if docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
    LOCAL_IMAGE_ID=$(docker image inspect "$IMAGE_NAME" --format '{{.Id}}')
fi

echo "Pulling latest image..."
docker pull "$IMAGE_NAME"
PULLED_IMAGE_ID=$(docker image inspect "$IMAGE_NAME" --format '{{.Id}}')

# The pull leaves the previous image untagged but present, so if it is the
# newer of the two its ID can take the tag back.
if [[ -n "$LOCAL_IMAGE_ID" && "$LOCAL_IMAGE_ID" != "$PULLED_IMAGE_ID" ]]; then
    LOCAL_CREATED=$(image_created_epoch "$LOCAL_IMAGE_ID")
    PULLED_CREATED=$(image_created_epoch "$PULLED_IMAGE_ID")
    if [[ "$LOCAL_CREATED" -gt "$PULLED_CREATED" ]]; then
        echo "Local image is newer than the registry's; keeping it."
        docker tag "$LOCAL_IMAGE_ID" "$IMAGE_NAME"
    fi
fi

TARGET_IMAGE_ID=$(docker image inspect "$IMAGE_NAME" --format '{{.Id}}')
echo "Target image: $TARGET_IMAGE_ID"

# Compare against what each container actually runs, not against the tag's
# previous value: a run that moved the tag but failed to recreate a container
# must leave that container to be retried, not report it as up to date.
STALE=()
for N in $(seq 1 "$INSTANCE_COUNT"); do
    RUNNING_IMAGE_ID=$(docker container inspect "${CONTAINER_PREFIX}$N" --format '{{.Image}}' 2>/dev/null || true)
    if [[ "$FORCE_UPDATE" == "true" || "$RUNNING_IMAGE_ID" != "$TARGET_IMAGE_ID" ]]; then
        STALE+=("$N")
    fi
done

if [[ ${#STALE[@]} -eq 0 ]]; then
    echo "All containers already run the target image. No update needed."
    echo "Use --force to update anyway."
    exit 0
fi

if [[ "$FORCE_UPDATE" == "true" ]]; then
    echo "Force update requested. Updating containers..."
else
    echo "Updating containers not on the target image: ${STALE[*]}"
fi

# Function to update a single container. Returns non-zero if the container
# could not be switched to the target image.
update_container() {
    local N=$1
    local CONTAINER_NAME="${CONTAINER_PREFIX}$N"
    echo "[$N] Starting update process for $CONTAINER_NAME..."

    if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
        # Stop if running
        if [[ "$(docker container inspect "$CONTAINER_NAME" --format '{{.State.Running}}')" == "true" ]]; then
            echo "[$N] Stopping $CONTAINER_NAME (gracefully, may take up to 30+ minutes for running builds)..."
            local stopped=false
            for attempt in {1..5}; do
                if docker stop --timeout=-1 "$CONTAINER_NAME"; then
                    echo "[$N] $CONTAINER_NAME stopped successfully"
                    stopped=true
                    break
                else
                    echo "[$N] Failed to stop $CONTAINER_NAME (attempt $attempt/5)"
                    if [[ $attempt -lt 5 ]]; then
                        sleep 1
                    fi
                fi
            done
            if [[ "$stopped" != "true" ]]; then
                echo "[$N] ✗ Could not stop $CONTAINER_NAME; it keeps its current image"
                return 1
            fi
        else
            echo "[$N] $CONTAINER_NAME is not running, skipping stop"
        fi

        # Remove
        echo "[$N] Removing $CONTAINER_NAME..."
        local removed=false
        for attempt in {1..5}; do
            if docker rm "$CONTAINER_NAME" 2>/dev/null; then
                echo "[$N] $CONTAINER_NAME removed successfully"
                removed=true
                break
            else
                echo "[$N] Failed to remove $CONTAINER_NAME (attempt $attempt/5)"
                if [[ $attempt -lt 5 ]]; then
                    sleep 1
                fi
            fi
        done
        if [[ "$removed" != "true" ]]; then
            echo "[$N] ✗ Could not remove $CONTAINER_NAME"
            return 1
        fi
    else
        echo "[$N] $CONTAINER_NAME does not exist, skipping stop and remove"
    fi

    # Recreate
    echo "[$N] Creating new $CONTAINER_NAME..."
    if ! docker run \
        --runtime sysbox-runc \
        -v "/var/lib/buildkite/hooks:/buildkite/hooks" \
        -v "/var/lib/buildkite-secrets:/buildkite-secrets:ro" \
        -e BUILDKITE_AGENT_TOKEN="$BUILDKITE_AGENT_TOKEN" \
        --memory-reservation "$MEMORY_RESERVATION" \
        -m "$MEMORY_LIMIT" \
        -d -t --name "$CONTAINER_NAME" \
        "$IMAGE_NAME" \
        buildkite-agent start --tags-from-host --tags "$QUEUE_TAGS"; then
        echo "[$N] ✗ Could not create $CONTAINER_NAME"
        return 1
    fi

    echo "[$N] ✓ $CONTAINER_NAME updated successfully!"
}

# Update the stale containers in parallel, collecting each one's exit status:
# a bare `wait` returns 0 however the jobs ended.
echo "Starting container updates..."
echo ""

PIDS=()
for N in "${STALE[@]}"; do
    update_container "$N" &
    PIDS+=("$!")
done

FAILED=0
for PID in "${PIDS[@]}"; do
    if ! wait "$PID"; then
        FAILED=$((FAILED + 1))
    fi
done
echo ""
if [[ $FAILED -eq 0 ]]; then
    echo "All container updates completed!"
else
    echo "$FAILED container update(s) failed; the next run retries them."
fi

echo "Active containers:"
docker ps --filter "name=${CONTAINER_PREFIX}" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"

echo ""
echo "Cleaning up unused Docker resources..."
docker container prune -f
docker image prune -f
docker volume prune -f
docker network prune -f
echo "Docker cleanup completed!"

if [[ $FAILED -gt 0 ]]; then
    exit 1
fi
echo "Update completed successfully!"
