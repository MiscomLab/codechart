#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$(dirname "$0")/lib.sh"
. "$SCRIPT_DIR/util.sh"
source ./lib.sh

deploy() {
  echo "deploying"
}

deploy
