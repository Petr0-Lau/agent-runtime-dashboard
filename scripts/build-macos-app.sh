#!/bin/zsh
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
release_dir="$repo_root/release"
bundle="$release_dir/Agent Runtime Dashboard.app"
resources="$bundle/Contents/Resources"
target_arch="$(uname -m)"

npm --prefix "$repo_root" run build
rm -rf "$bundle"
mkdir -p "$bundle/Contents/MacOS" "$resources/app/server" "$resources/app/config" "$resources/app/dist" "$resources/app/node_modules"

swiftc -O -parse-as-library -target "${target_arch}-apple-macosx13.0" \
  -o "$bundle/Contents/MacOS/Agent Runtime Dashboard" \
  "$repo_root/macos/AgentRuntimeDashboardApp.swift" \
  -framework Cocoa \
  -framework WebKit

cp "$repo_root/macos/Info.plist" "$bundle/Contents/Info.plist"
cp -R "$repo_root/dist/." "$resources/app/dist/"
cp "$repo_root/server/index.mjs" "$resources/app/server/index.mjs"
cp "$repo_root/config/settings.json" "$resources/app/config/settings.json"
cp -R "$repo_root/node_modules/systeminformation" "$resources/app/node_modules/systeminformation"
cp -L "$(command -v node)" "$resources/node"
chmod +x "$bundle/Contents/MacOS/Agent Runtime Dashboard" "$resources/node"

echo "Built: $bundle"
