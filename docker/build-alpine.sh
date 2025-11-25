#!/usr/bin/env sh

docker build --platform linux/amd64 -t ghcr.io/divvun/divvun-actions:alpine-latest -f ./Dockerfile.alpine .
