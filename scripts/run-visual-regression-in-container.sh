#!/bin/sh
# Runs the Storybook visual regression suite in the same Playwright image as CI,
# so screenshots do not depend on the fonts and renderer of the local machine.
# Bun is installed inside the container at the version pinned by `packageManager`,
# so the script also works on hosts whose own bun binary is not a Linux build.
# Usage: bun run web:visual:docker [--update-snapshots]
# A leading `--` is dropped, because Playwright would otherwise treat every later
# argument as a test-file filter instead of an option.
# The container runs as root, so the reports and screenshots it writes into the
# bind-mounted checkout are handed back to the invoking user before it exits.
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

if [ "${1:-}" = "--" ]; then
  shift
fi

exec docker run --rm --ipc=host \
  -v "$PWD:/work" \
  -w /work \
  -e "BUN_VERSION=$bun_version" \
  -e "HOST_UID=$(id -u)" \
  -e "HOST_GID=$(id -g)" \
  "$image" \
  sh -c 'npm install --global --silent --no-audit --no-fund "bun@$BUN_VERSION" || exit $?
status=0
npx playwright test -c playwright.visual.config.ts "$@" || status=$?
for output in playwright-visual-report test-results web/visual/__screenshots__; do
  if [ -e "$output" ]; then chown -R "$HOST_UID:$HOST_GID" "$output"; fi
done
exit "$status"' \
  run-visual-regression "$@"
