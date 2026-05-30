#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[codex-setup] %s\n' "$*"
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

required_bun_version="$(
  sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"bun@\([^"]*\)".*/\1/p' package.json | head -n 1
)"

if [ -z "$required_bun_version" ]; then
  required_bun_version="${BUN_VERSION:-1.3.10}"
fi

export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"

if [ -d "$BUN_INSTALL/bin" ]; then
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

persist_bun_path() {
  local bashrc="$HOME/.bashrc"
  local marker="# mukuroji Codex Bun path"

  if ! grep -Fq "$marker" "$bashrc" 2>/dev/null; then
    {
      printf '\n%s\n' "$marker"
      printf 'export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"\n'
      printf 'export PATH="$BUN_INSTALL/bin:$PATH"\n'
    } >>"$bashrc"
  fi
}

install_bun() {
  if ! command -v curl >/dev/null 2>&1; then
    log "curl is required to install Bun ${required_bun_version}."
    exit 1
  fi

  log "Installing Bun ${required_bun_version}..."
  # Codex setup runs in a disposable environment, so install the pinned Bun release directly.
  curl -fsSL https://bun.sh/install | bash -s "bun-v${required_bun_version}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  persist_bun_path
}

if command -v bun >/dev/null 2>&1; then
  current_bun_version="$(bun --version)"
  if [ "$current_bun_version" != "$required_bun_version" ]; then
    log "Bun ${current_bun_version} is installed, but ${required_bun_version} is required."
    install_bun
  else
    log "Using Bun ${current_bun_version}."
    persist_bun_path
  fi
else
  install_bun
fi

current_bun_version="$(bun --version)"
if [ "$current_bun_version" != "$required_bun_version" ]; then
  log "Expected Bun ${required_bun_version}, but found ${current_bun_version}."
  exit 1
fi

log "Installing workspace dependencies..."
bun install --frozen-lockfile

if [ "${CODEX_VALIDATE:-0}" = "1" ]; then
  log "Running validation checks..."
  bun run web:lint
  bun run web:build
  bun run web:build-storybook
  bun run cdk:build
  bun run cdk:test
fi

log "Setup complete."
