#!/usr/bin/env bash

set -euo pipefail

# Configuration with defaults
INSTANCE_COUNT=${INSTANCE_COUNT:-4}
MEMORY_RESERVATION=${MEMORY_RESERVATION:-6g}
MEMORY_LIMIT=${MEMORY_LIMIT:-24g}
IMAGE_NAME="ghcr.io/divvun/divvun-actions:ubuntu-latest"

# Check required environment variables
if [[ -z "${BUILDKITE_AGENT_TOKEN:-}" ]]; then
    echo "Error: BUILDKITE_AGENT_TOKEN environment variable is required"
    exit 1
fi

echo "Configuration:"
echo "  Instance Count: $INSTANCE_COUNT"
echo "  Memory Reservation: $MEMORY_RESERVATION"
echo "  Memory Limit: $MEMORY_LIMIT"
echo "  Image: $IMAGE_NAME"
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

# Check if image has changed
if [[ "$CURRENT_IMAGE_ID" == "$NEW_IMAGE_ID" && -n "$CURRENT_IMAGE_ID" ]]; then
    echo "Image has not changed. No update needed."
    exit 0
fi

echo "Image has changed. Updating containers..."

# Function to update a single container
update_container() {
    local N=$1
    echo "[$N] Starting update process for builder-$N..."
    
    # Stop if exists
    if docker ps -q --filter "name=builder-$N" | grep -q .; then
        echo "[$N] Stopping builder-$N (gracefully, may take up to 30+ minutes for running builds)..."
        docker stop --timeout=-1 "builder-$N" || echo "[$N] Failed to stop builder-$N (may not exist)"
        echo "[$N] builder-$N stopped successfully"
    else
        echo "[$N] builder-$N is not running, skipping stop"
    fi
    
    # Remove
    echo "[$N] Removing builder-$N..."
    docker rm "builder-$N" 2>/dev/null || echo "[$N] Container builder-$N already removed or doesn't exist"
    
    # Recreate
    echo "[$N] Creating new builder-$N..."
    docker run \
        -v "/var/lib/buildkite/hooks:/buildkite/hooks" \
        -v "/var/lib/buildkite-secrets:/buildkite-secrets:ro" \
        -e BUILDKITE_AGENT_TOKEN="$BUILDKITE_AGENT_TOKEN" \
        -v "/var/run/docker.sock:/var/run/docker.sock" \
        --memory-reservation "$MEMORY_RESERVATION" \
        -m "$MEMORY_LIMIT" \
        -d -t --name "builder-$N" \
        "$IMAGE_NAME" \
        buildkite-agent start --tags-from-host --tags queue=linux
        
    echo "[$N] ✓ builder-$N updated successfully!"
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
docker ps --filter "name=builder-" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"