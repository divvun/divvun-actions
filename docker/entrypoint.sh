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

check_docker_is_alive () {
  while (! docker stats --no-stream &>>/dev/null ); do
    # Docker takes a few seconds to initialize.
    sleep 1
  done
}
export -f check_docker_is_alive

sudo dockerd -H tcp://0.0.0.0:2375 -H unix:///var/run/docker.sock &>>/dev/null &

 # Time out after 1m to avoid waiting on docker forever.
timeout 60s bash -c check_docker_is_alive 

# Trap SIGTERM and SIGINT signals
trap shutdown SIGTERM SIGINT

# Execute the command passed to the container
exec "$@" &
wait $!
