#!/usr/bin/env sh

docker build --platform linux/amd64 -t ghcr.io/divvun/divvun-actions:worker-alpine-latest -f ./Dockerfile.alpine .
