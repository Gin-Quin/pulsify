#!/bin/sh
# Stage the build context next to the Kraftfile: the x86-64 runner binary and a
# fixture (profile: small, medium or large).
#   benchmarks/database/unikraft/stage.sh large
#   unikraft build benchmarks/database/unikraft --output <org>/pulsify-db-bench:latest
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/../../.."
docker buildx build --platform linux/amd64 -f benchmarks/database/native.Dockerfile \
	-t pulsify-native-benchmark:amd64 --load .
id=$(docker create --platform linux/amd64 pulsify-native-benchmark:amd64)
docker cp "$id:/usr/local/bin/pulsify-db-bench" "$here/pulsify-db-bench"
docker rm "$id" >/dev/null
bun benchmarks/database/native-fixtures.ts generate "$here/fixture.json" "${1:-large}" 128 1000
