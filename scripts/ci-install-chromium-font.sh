#!/usr/bin/env bash
set -euo pipefail

start=$(date +%s%3N)
# This Ubuntu 24.04 package is also installed by Playwright's WebKit deps.
font_tree="$(mktemp -d)"
trap 'rm -rf "$font_tree"' EXIT
font="$font_tree/fonts-wqy-zenhei_0.9.45-8_all.deb"
curl --fail --silent --show-error --location --output "$font" \
  https://archive.ubuntu.com/ubuntu/pool/universe/f/fonts-wqy-zenhei/fonts-wqy-zenhei_0.9.45-8_all.deb
echo "496969d65dc5664a3291e678d5cbef6815dc308ee5bf37b656c00af2cb490410  $font" | sha256sum --check
checked=$(date +%s%3N)
dpkg-deb --extract "$font" "$font_tree"
sudo cp -a "$font_tree/usr/share/fonts/truetype/wqy" /usr/share/fonts/truetype/
sudo cp -a "$font_tree/etc/fonts/." /etc/fonts/
installed=$(date +%s%3N)
font_match="$(fc-match -f '%{file}' 'WenQuanYi Zen Hei')"
[[ "$font_match" == /usr/share/fonts/truetype/wqy/wqy-zenhei.ttc ]]
echo "Font fetch and checksum: $((checked-start)) ms; extract and install: $((installed-checked)) ms; match: $(( $(date +%s%3N) - installed )) ms"
