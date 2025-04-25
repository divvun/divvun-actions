#!/usr/bin/env sh

docker build --platform linux/amd64 -t divvun-actions:latest -f ./Dockerfile.linux .