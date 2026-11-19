#!/usr/bin/env bash
# Preserve the command's exit status and let it finish even when it exceeds its budget.
set -eu
budget_ms=$1
shift
start=$(date +%s%3N)
"$@"
elapsed=$(( $(date +%s%3N) - start ))
echo "Execution: ${elapsed} ms (budget < ${budget_ms} ms)"
test "$elapsed" -lt "$budget_ms"
