#!/usr/bin/env bash
# Install or verify the mukuroji-review Skill from the trusted default branch.
#
# Usage:
#   bash scripts/sync-review-skill.sh install <claude|kiro|codex|DEST_DIR>
#   bash scripts/sync-review-skill.sh check   <claude|kiro|codex|DEST_DIR>
#
# The Skill tree is always read from a pinned commit of the trusted ref
# (default: origin/main), never from the working tree, so a feature branch
# cannot change the reviewer instructions it is reviewed with.
set -euo pipefail

log() {
  printf '[sync-review-skill] %s\n' "$*" >&2
}

usage() {
  log "usage: sync-review-skill.sh <install|check> <claude|kiro|codex|DEST_DIR>"
  exit 2
}

[ "$#" -eq 2 ] || usage
mode="$1"
target="$2"

skill_path=".codex/skills/mukuroji-review"
trusted_remote="${MUKUROJI_TRUSTED_REMOTE:-origin}"
trusted_branch="${MUKUROJI_TRUSTED_BRANCH:-main}"

case "$target" in
  claude) dest="$HOME/.claude/skills/mukuroji-review" ;;
  kiro) dest="$HOME/.kiro/skills/mukuroji-review" ;;
  codex) dest="${CODEX_HOME:-$HOME/.codex}/skills/mukuroji-review" ;;
  /*) dest="$target" ;;
  *)
    log "DEST_DIR must be an absolute path: $target"
    exit 2
    ;;
esac

case "$mode" in
  install | check) ;;
  *) usage ;;
esac

# Resolve a path through symlinks, including parents that already exist, so
# the repository containment check below compares physical locations.
canonical_path() {
  local existing="$1" rest=""
  while [ ! -d "$existing" ]; do
    rest="/$(basename "$existing")$rest"
    existing="$(dirname "$existing")"
  done
  printf '%s%s\n' "$(cd "$existing" && pwd -P)" "$rest"
}

case "/$dest/" in
  */./* | */../*)
    log "DEST_DIR must not contain '.' or '..' components: $dest"
    exit 2
    ;;
esac

repo_root="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"
cd "$repo_root"
dest="$(canonical_path "$dest")"

case "$dest" in
  "$repo_root" | "$repo_root"/*)
    log "Install the Skill outside the repository so branch changes cannot rewrite it: $dest"
    exit 1
    ;;
esac

git fetch --quiet "$trusted_remote" "$trusted_branch"
trusted_oid="$(git rev-parse --verify "FETCH_HEAD^{commit}")"
log "Trusted source: ${trusted_remote}/${trusted_branch} @ ${trusted_oid}"

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

git archive --format=tar "$trusted_oid" "$skill_path" | tar -x -C "$work_dir"
trusted_tree="$work_dir/$skill_path"

if [ "$mode" = "check" ]; then
  if [ ! -d "$dest" ]; then
    log "FAILED: Skill is not installed at $dest"
    exit 1
  fi
  if ! diff -r "$trusted_tree" "$dest" >&2; then
    log "FAILED: installed copy at $dest does not match ${trusted_oid}"
    exit 1
  fi
  log "OK: $dest matches ${trusted_oid}"
  printf '%s\n' "$trusted_oid"
  exit 0
fi

backup=""
if [ -e "$dest" ]; then
  backup="$work_dir/backup"
  mv "$dest" "$backup"
fi

mkdir -p "$(dirname "$dest")"
if ! cp -R "$trusted_tree" "$dest"; then
  log "Install failed; restoring the previous copy."
  rm -rf "$dest"
  [ -z "$backup" ] || mv "$backup" "$dest"
  exit 1
fi

log "Installed $dest from ${trusted_oid}"
printf '%s\n' "$trusted_oid"
