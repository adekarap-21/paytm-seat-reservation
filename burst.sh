#!/usr/bin/env bash
set -euo pipefail
BASE_URL="${1:-${BASE_URL:-http://localhost:8080}}"
export BASE_URL
exec node --import tsx scripts/burst.ts "$BASE_URL"
