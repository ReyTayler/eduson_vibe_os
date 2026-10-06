#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export CI=true
cd /opt/vibe-os/build/deepseek-harness
pnpm install --frozen-lockfile
pnpm run build
printf '%s\n' UPSTREAM_BUILD_OK
