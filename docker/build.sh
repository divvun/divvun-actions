#!/usr/bin/env sh

sudo mkdir -p /var/lib/docker/tmp
docker build --platform linux/amd64 -t ghcr.io/divvun/divvun-actions:ubuntu-latest -f ./Dockerfile.linux .