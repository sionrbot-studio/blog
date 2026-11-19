#!/usr/bin/env bash
set -eu

# Formatting reads the checkout independently of Astro's generated types.
vp fmt --check &
format_pid=$!

status=0
(vp run --no-cache check && vp check --no-fmt) || status=$?
wait "$format_pid" || status=$?
exit "$status"
