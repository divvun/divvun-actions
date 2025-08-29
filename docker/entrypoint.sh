#!/bin/bash

# Handle termination signals gracefully
shutdown() {
    echo "Received termination signal, stopping buildkite-agent gracefully..."
    if command -v buildkite-agent &> /dev/null; then
        buildkite-agent stop
    fi
    exit 0
}

# Trap SIGTERM and SIGINT signals
trap shutdown SIGTERM SIGINT

# Execute the command passed to the container
exec "$@" &
wait $!
