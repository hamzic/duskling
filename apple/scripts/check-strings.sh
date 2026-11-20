#!/bin/bash
# Fails when App/Localizable.xcstrings is out of date with the app's source: a string used in code that's missing from
# the catalog, or a catalog entry no longer used. Run after a build of the Dusk target; pass that build's DerivedData path.
# The build writes one .stringsdata per Swift file (SWIFT_EMIT_LOC_STRINGS, project.yml); `xcstringstool sync` merges
# them into a catalog the way Xcode does on build, so a sync that changes a copy of the catalog means it's stale.
# To update the catalog itself, run the same sync on apple/App/Localizable.xcstrings, then give each new key an explicit
# English value (LocalizationTests: a key without one isn't compiled into the app's en.lproj).
set -euo pipefail
derived="${1:?usage: check-strings.sh <DerivedData path>}"
catalog="$(cd "$(dirname "$0")/.." && pwd)/App/Localizable.xcstrings"
data=$(find "$derived/Build/Intermediates.noindex/Dusk.build" -path "*/Dusk.build/Objects-normal/*" -name "*.stringsdata" \
  ! -name "ExtractedAppShortcutsMetadata.stringsdata" ! -name "GeneratedAssetSymbols.stringsdata")
test -n "$data" || { echo "error: no .stringsdata under $derived; build the Dusk target first" >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# sync matches .stringsdata tables to catalogs by file name, so the copy keeps the name Localizable.xcstrings.
cp "$catalog" "$work/Localizable.xcstrings"
args=()
while IFS= read -r f; do args+=(--stringsdata "$f"); done <<< "$data"
xcrun xcstringstool sync "$work/Localizable.xcstrings" "${args[@]}"
if ! diff -u "$catalog" "$work/Localizable.xcstrings"; then
  echo "error: apple/App/Localizable.xcstrings is out of date (diff above)" >&2
  exit 1
fi
echo "Localizable.xcstrings matches the app's strings"
