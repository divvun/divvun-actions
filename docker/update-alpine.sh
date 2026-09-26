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
            echo "  INSTANCE_COUNT           Number of builder instances (default: 2)"
            echo "  CONTAINER_PREFIX         Container name prefix (default: 'builder-alpine-')"
            echo "  QUEUE_TAGS               Buildkite queue tags (default: 'queue=alpine')"
            echo "  MEMORY_RESERVATION       Memory reservation per container (default: 4g)"
            echo "  MEMORY_LIMIT             Memory limit per container (default: 16g)"
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
INSTANCE_COUNT=${INSTANCE_COUNT:-2}
MEMORY_RESERVATION=${MEMORY_RESERVATION:-4g}
MEMORY_LIMIT=${MEMORY_LIMIT:-16g}
CONTAINER_PREFIX=${CONTAINER_PREFIX:-"builder-alpine-"}
QUEUE_TAGS=${QUEUE_TAGS:-"queue=alpine"}
IMAGE_NAME="ghcr.io/divvun/divvun-actions:alpine-latest"

# Check required environment variables
if [[ -z "${BUILDKITE_AGENT_TOKEN:-}" ]]; then
    echo "Error: BUILDKITE_AGENT_TOKEN environment variable is required"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "Script: $SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}") at divvun-actions $(git -C "$SCRIPT_DIR" log -1 --format='%h %cd' --date=iso 2>/dev/null || echo '(commit unknown)')"
echo "Docker storage driver: $(docker info --format '{{.Driver}}' 2>/dev/null || echo unknown)"
echo ""

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

# "<id> (built <time>)", for the log.
describe_image() {
    echo "$1 (built $(docker image inspect "$1" --format '{{.Created}}' 2>/dev/null || echo unknown))"
}

# Note the local image before pulling: `docker pull` moves the tag to whatever
# the registry has, even when that is older than an image built on this host.
echo "Checking current image..."
LOCAL_IMAGE_ID=""
if docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
    LOCAL_IMAGE_ID=$(docker image inspect "$IMAGE_NAME" --format '{{.Id}}')
    echo "  Local image before pull:  $(describe_image "$LOCAL_IMAGE_ID")"
else
    echo "  Local image before pull:  none"
fi

echo "Pulling latest image..."
docker pull "$IMAGE_NAME"
PULLED_IMAGE_ID=$(docker image inspect "$IMAGE_NAME" --format '{{.Id}}')
echo "  Registry image:           $(describe_image "$PULLED_IMAGE_ID")"

# The pull leaves the previous image untagged but present, so if it is the
# newer of the two its ID can take the tag back.
if [[ -z "$LOCAL_IMAGE_ID" ]]; then
    echo "  Decision: no local image, using the registry's."
elif [[ "$LOCAL_IMAGE_ID" == "$PULLED_IMAGE_ID" ]]; then
    echo "  Decision: local image IS the registry's image, nothing to choose."
else
    LOCAL_CREATED=$(image_created_epoch "$LOCAL_IMAGE_ID")
    PULLED_CREATED=$(image_created_epoch "$PULLED_IMAGE_ID")
    echo "  Build times (epoch): local $LOCAL_CREATED, registry $PULLED_CREATED"
    if [[ "$LOCAL_CREATED" -gt "$PULLED_CREATED" ]]; then
        echo "  Decision: local image is newer, keeping it (re-tagging $LOCAL_IMAGE_ID)."
        docker tag "$LOCAL_IMAGE_ID" "$IMAGE_NAME"
    else
        echo "  Decision: registry image is newer (or same age), using it."
    fi
fi

TARGET_IMAGE_ID=$(docker image inspect "$IMAGE_NAME" --format '{{.Id}}')
echo "Target image: $(describe_image "$TARGET_IMAGE_ID")"
echo ""

# Compare against what each container actually runs, not against the tag's
# previous value: a run that moved the tag but failed to recreate a container
# must leave that container to be retried, not report it as up to date.
echo "Containers:"
STALE=()
for N in $(seq 1 "$INSTANCE_COUNT"); do
    CONTAINER_NAME="${CONTAINER_PREFIX}$N"
    RUNNING_IMAGE_ID=$(docker container inspect "$CONTAINER_NAME" --format '{{.Image}}' 2>/dev/null || true)
    if [[ -z "$RUNNING_IMAGE_ID" ]]; then
        echo "  $CONTAINER_NAME: missing -> recreate"
        STALE+=("$N")
    elif [[ "$RUNNING_IMAGE_ID" != "$TARGET_IMAGE_ID" ]]; then
        echo "  $CONTAINER_NAME: runs $(describe_image "$RUNNING_IMAGE_ID"), not the target -> recreate"
        STALE+=("$N")
    elif [[ "$FORCE_UPDATE" == "true" ]]; then
        echo "  $CONTAINER_NAME: runs the target, --force -> recreate"
        STALE+=("$N")
    else
        echo "  $CONTAINER_NAME: runs the target -> keep"
    fi
done
echo ""

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
                echo "[$N] Could not stop $CONTAINER_NAME; it keeps its current image"
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
            echo "[$N] Could not remove $CONTAINER_NAME"
            return 1
        fi
    else
        echo "[$N] $CONTAINER_NAME does not exist, skipping stop and remove"
    fi

    # Recreate (no --runtime sysbox-runc since Alpine doesn't need Docker-in-Docker)
    echo "[$N] Creating new $CONTAINER_NAME..."
    if ! docker run \
        -v "/var/lib/buildkite/hooks:/buildkite/hooks" \
        -v "/var/lib/buildkite-secrets:/buildkite-secrets:ro" \
        -e BUILDKITE_AGENT_TOKEN="$BUILDKITE_AGENT_TOKEN" \
        --memory-reservation "$MEMORY_RESERVATION" \
        -m "$MEMORY_LIMIT" \
        -d -t --name "$CONTAINER_NAME" \
        "$IMAGE_NAME" \
        buildkite-agent start --tags-from-host --tags "$QUEUE_TAGS"; then
        echo "[$N] Could not create $CONTAINER_NAME"
        return 1
    fi

    echo "[$N] $CONTAINER_NAME updated successfully!"
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
echo "Docker cleanup completed!"

if [[ $FAILED -gt 0 ]]; then
    exit 1
fi
echo "Update completed successfully!"
