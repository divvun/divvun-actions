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
            echo "Options:"
            echo "  -f, --force    Force update even if image hasn't changed"
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

echo "Configuration:"
echo "  Instance Count: $INSTANCE_COUNT"
echo "  Container Prefix: $CONTAINER_PREFIX"
echo "  Queue Tags: $QUEUE_TAGS"
echo "  Memory Reservation: $MEMORY_RESERVATION"
echo "  Memory Limit: $MEMORY_LIMIT"
echo "  Image: $IMAGE_NAME"
echo "  Force Update: $FORCE_UPDATE"
echo ""

# Get current image ID
echo "Checking current image..."
CURRENT_IMAGE_ID=""
if docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
    CURRENT_IMAGE_ID=$(docker image inspect "$IMAGE_NAME" --format '{{.Id}}')
fi

# Pull latest image
echo "Pulling latest image..."
docker pull "$IMAGE_NAME"

# Get new image ID
NEW_IMAGE_ID=$(docker image inspect "$IMAGE_NAME" --format '{{.Id}}')

# Check if image has changed or force update is requested
if [[ "$CURRENT_IMAGE_ID" == "$NEW_IMAGE_ID" && -n "$CURRENT_IMAGE_ID" && "$FORCE_UPDATE" == "false" ]]; then
    echo "Image has not changed. No update needed."
    echo "Use --force to update anyway."
    exit 0
fi

if [[ "$FORCE_UPDATE" == "true" ]]; then
    echo "Force update requested. Updating containers..."
else
    echo "Image has changed. Updating containers..."
fi

# Function to update a single container
update_container() {
    local N=$1
    local CONTAINER_NAME="${CONTAINER_PREFIX}$N"
    echo "[$N] Starting update process for $CONTAINER_NAME..."

    # Stop if exists
    if docker ps -q --filter "name=$CONTAINER_NAME" | grep -q .; then
        echo "[$N] Stopping $CONTAINER_NAME (gracefully, may take up to 30+ minutes for running builds)..."
        for attempt in {1..5}; do
            if docker stop --timeout=-1 "$CONTAINER_NAME"; then
                echo "[$N] $CONTAINER_NAME stopped successfully"
                break
            else
                echo "[$N] Failed to stop $CONTAINER_NAME (attempt $attempt/5)"
                if [[ $attempt -lt 5 ]]; then
                    sleep 1
                fi
            fi
        done
    else
        echo "[$N] $CONTAINER_NAME is not running, skipping stop"
    fi

    # Remove
    echo "[$N] Removing $CONTAINER_NAME..."
    for attempt in {1..5}; do
        if docker rm "$CONTAINER_NAME" 2>/dev/null; then
            echo "[$N] $CONTAINER_NAME removed successfully"
            break
        else
            echo "[$N] Failed to remove $CONTAINER_NAME (attempt $attempt/5)"
            if [[ $attempt -lt 5 ]]; then
                sleep 1
            fi
        fi
    done

    # Recreate (no --runtime sysbox-runc since Alpine doesn't need Docker-in-Docker)
    echo "[$N] Creating new $CONTAINER_NAME..."
    docker run \
        -v "/var/lib/buildkite/hooks:/buildkite/hooks" \
        -v "/var/lib/buildkite-secrets:/buildkite-secrets:ro" \
        -e BUILDKITE_AGENT_TOKEN="$BUILDKITE_AGENT_TOKEN" \
        --memory-reservation "$MEMORY_RESERVATION" \
        -m "$MEMORY_LIMIT" \
        -d -t --name "$CONTAINER_NAME" \
        "$IMAGE_NAME" \
        buildkite-agent start --tags-from-host --tags "$QUEUE_TAGS"

    echo "[$N] $CONTAINER_NAME updated successfully!"
}

# Update all containers in parallel
echo "Starting container updates..."
echo ""

for N in $(seq 1 "$INSTANCE_COUNT"); do
    update_container "$N" &
done

wait
echo ""
echo "All container updates completed!"

echo "Update completed successfully!"
echo "Active containers:"
docker ps --filter "name=${CONTAINER_PREFIX}" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"

echo ""
echo "Cleaning up unused Docker resources..."
docker container prune -f
docker image prune -f
echo "Docker cleanup completed!"
