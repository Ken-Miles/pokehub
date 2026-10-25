#!/bin/sh
# Builds the mGBA WebAssembly core (emulator/Dockerfile) into public/emulator/core/,
# or with args <dest> <context> another core (npm run emulator:build:ds: melonDS).
set -eu
tag=4.0.10
[ "$(uname -m)" = arm64 ] || [ "$(uname -m)" = aarch64 ] && tag=4.0.10-arm64
docker build --build-arg EMSDK_TAG="$tag" --target out --output type=local,dest="${1:-public/emulator/core}" "${2:-emulator}"
