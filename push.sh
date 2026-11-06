#!/usr/bin/env bash
# Build vu-monitor-2000 by hand and push it to Docker Hub.
# (Not needed if you use the GitHub Actions build, which pushes to ghcr.io.)
#
#   ./push.sh <dockerhub-username> [version]
set -euo pipefail

USER_NAME="${1:?usage: ./push.sh <dockerhub-username> [version]}"
VERSION="${2:-1.0.0}"
IMAGE="docker.io/${USER_NAME}/vu-monitor-2000"

cd "$(dirname "$0")"
docker info >/dev/null 2>&1 || { echo "Docker isn't running." >&2; exit 1; }

docker login -u "${USER_NAME}"
docker buildx inspect vumon-builder >/dev/null 2>&1 \
  || docker buildx create --name vumon-builder --use >/dev/null
docker buildx use vumon-builder
docker buildx build --platform linux/amd64,linux/arm64 \
  -t "${IMAGE}:${VERSION}" -t "${IMAGE}:latest" --push .

echo "Pushed ${IMAGE}:${VERSION} and ${IMAGE}:latest"
