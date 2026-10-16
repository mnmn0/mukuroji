#!/bin/sh
# Runs the Storybook visual regression suite in the same Playwright image as CI,
# so screenshots do not depend on the fonts and renderer of the local machine.
# Usage: bun run web:visual:docker [-- --update-snapshots]
set -eu

image="mcr.microsoft.com/playwright:v1.60.0-noble@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948"
bun_path="$(command -v bun)"

if [ ! -f web/storybook-static/index.json ]; then
  echo "Build Storybook first: bun run web:build-storybook" >&2
  exit 1
fi

exec docker run --rm --ipc=host \
  -v "$PWD:/work" \
  -v "$bun_path:/usr/local/bin/bun:ro" \
  -w /work \
  "$image" \
  npx playwright test -c playwright.visual.config.ts "$@"
