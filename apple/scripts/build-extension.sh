#!/bin/bash
# Builds the web extension and copies it into the Safari extension target's resources.
set -euo pipefail
cd "$(dirname "$0")/../../extension" && pnpm install --frozen-lockfile && pnpm run build && rsync -a --delete dist/ ../apple/Extension/Resources/

# project.yml copies each subdirectory of Extension/Resources as its own folder reference; a new one must be added there.
known="_locales boot icons popup prepaint"
for dir in ../apple/Extension/Resources/*/; do
  name=$(basename "$dir")
  case " $known " in *" $name "*) ;; *) echo "error: new directory dist/$name: add it to apple/project.yml (DuskExtension sources) and to this list" >&2; exit 1 ;; esac
done
