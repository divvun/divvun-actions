#!/usr/bin/env sh

docker build --platform linux/amd64 -t ghcr.io/divvun/divvun-actions:ubuntu-latest -f ./Dockerfile.linux .