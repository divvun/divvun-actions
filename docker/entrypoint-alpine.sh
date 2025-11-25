#!/bin/bash

# Handle termination signals gracefully
shutdown () {
    echo "Received termination signal, stopping buildkite-agent gracefully..."
    pkill buildkite-agent

    # Wait for agents to stop
    while true; do
        if ! pgrep buildkite-agent > /dev/null; then
            echo "No buildkite-agent processes detected, exiting..."
            exit 0
        fi
        sleep 1
    done
}

# Trap SIGTERM and SIGINT signals
trap shutdown SIGTERM SIGINT

# Execute the command passed to the container
exec "$@" &
wait $!
