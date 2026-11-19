#!/usr/bin/env bash
set -euo pipefail

cli=$(node --input-type=module <<'NODE'
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const web = createRequire(require.resolve('@e2e-dev/web'));
console.log(join(dirname(web.resolve('playwright-core/package.json')), 'cli.js'));
NODE
)
node "$cli" install --only-shell --no-progress "$@"
