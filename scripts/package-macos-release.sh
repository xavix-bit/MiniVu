#!/bin/bash

set -euo pipefail

app_path="${1:-src-tauri/target/release/bundle/macos/MiniVu.app}"
dmg_path="${2:-}"

if [[ ! -d "$app_path" ]]; then
  echo "App bundle not found: $app_path" >&2
  exit 1
fi

if [[ -z "$dmg_path" ]]; then
  dmg_path="$(find src-tauri/target/release/bundle/dmg -maxdepth 1 -name '*.dmg' -print -quit)"
fi

if [[ -z "$dmg_path" ]]; then
  echo "DMG output path not found" >&2
  exit 1
fi

# Tauri's ad hoc signature is created before bundled runtime resources are final.
# Re-sign every Mach-O file, then seal the completed application bundle.
while IFS= read -r -d '' item; do
  if file "$item" | grep -q 'Mach-O'; then
    codesign --force --sign - --timestamp=none "$item"
  fi
done < <(find "$app_path/Contents" -type f -print0)

codesign --force --deep --sign - --timestamp=none "$app_path"
codesign --verify --deep --strict --verbose=2 "$app_path"

staging_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$staging_dir"
}
trap cleanup EXIT

ditto "$app_path" "$staging_dir/MiniVu.app"
ln -s /Applications "$staging_dir/Applications"

mkdir -p "$(dirname "$dmg_path")"
rm -f "$dmg_path"
hdiutil create \
  -volname MiniVu \
  -srcfolder "$staging_dir" \
  -format UDZO \
  -ov \
  "$dmg_path"
hdiutil verify "$dmg_path"
