#!/bin/sh
# Runs the Storybook visual regression suite in the same Playwright image as CI,
# so screenshots do not depend on the fonts and renderer of the local machine.
# Bun is installed inside the container at the version pinned by `packageManager`,
# so the script also works on hosts whose own bun binary is not a Linux build.
# Usage: bun run web:visual:docker [-- --update-snapshots]
set -eu

image="mcr.microsoft.com/playwright:v1.60.0-noble@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948"
bun_version="$(sed -n 's/^[[:space:]]*"packageManager": "bun@\([0-9][0-9.]*\)".*/\1/p' package.json)"

if [ -z "$bun_version" ]; then
  echo "package.json must pin bun in packageManager (bun@<version>)." >&2
  exit 1
fi
if [ ! -f web/storybook-static/index.json ]; then
  echo "Build Storybook first: bun run web:build-storybook" >&2
  exit 1
fi

exec docker run --rm --ipc=host \
  -v "$PWD:/work" \
  -w /work \
  -e "BUN_VERSION=$bun_version" \
  "$image" \
  sh -c 'npm install --global --silent --no-audit --no-fund "bun@$BUN_VERSION" && exec npx playwright test -c playwright.visual.config.ts "$@"' \
  run-visual-regression "$@"
