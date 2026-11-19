#!/usr/bin/env bash
set -euo pipefail

install_font() {
  # This Ubuntu 24.04 package is also installed by Playwright's WebKit deps.
  font_tree="$(mktemp -d)"
  trap 'rm -rf "$font_tree"' EXIT
  font="$font_tree/fonts-wqy-zenhei_0.9.45-8_all.deb"
  curl --fail --silent --show-error --location --output "$font" \
    https://archive.ubuntu.com/ubuntu/pool/universe/f/fonts-wqy-zenhei/fonts-wqy-zenhei_0.9.45-8_all.deb
  echo "496969d65dc5664a3291e678d5cbef6815dc308ee5bf37b656c00af2cb490410  $font" | sha256sum --check
  dpkg-deb --extract "$font" "$font_tree"
  sudo cp -a "$font_tree/usr/share/fonts/truetype/wqy" /usr/share/fonts/truetype/
  sudo cp -a "$font_tree/etc/fonts/." /etc/fonts/
  font_match="$(fc-match -f '%{file}' 'WenQuanYi Zen Hei')"
  [[ "$font_match" == /usr/share/fonts/truetype/wqy/wqy-zenhei.ttc ]]
}

install_font &
font_pid=$!
cli=$(node --input-type=module <<'NODE'
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const web = createRequire(require.resolve('@e2e-dev/web'));
console.log(join(dirname(web.resolve('playwright-core/package.json')), 'cli.js'));
NODE
)
node "$cli" install --only-shell --no-progress chromium
wait "$font_pid"

node --input-type=module <<'NODE'
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const web = createRequire(require.resolve('@e2e-dev/web'));
const browser = await web('playwright-core').chromium.launch();
console.log(`Chromium ${browser.version()} launched successfully`);
await browser.close();
NODE
