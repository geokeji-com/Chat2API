#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export CHAT2API_AUTO_START_PROXY="${CHAT2API_AUTO_START_PROXY:-true}"
export CHAT2API_PROXY_HOST="${CHAT2API_PROXY_HOST:-0.0.0.0}"
export CHAT2API_PROXY_PORT="${CHAT2API_PROXY_PORT:-8080}"
export CHAT2API_OPEN_DEVTOOLS="${CHAT2API_OPEN_DEVTOOLS:-false}"
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"

exec npm run dev
