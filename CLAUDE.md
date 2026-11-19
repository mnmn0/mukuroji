# CLAUDE.md

Claude Code はこのファイルを読みます。リポジトリの規則は `AGENTS.md` にあり、下の行で取り込みます。
規則を変えるときは `AGENTS.md` を変更し、このファイルには Claude Code 固有の手順だけを書きます。

@AGENTS.md

## Claude Code 固有の手順

- 環境の用意、push 前レビュー用 `mukuroji-review` Skill の導入と照合は
  [docs/coding-agents.md](docs/coding-agents.md) に従う。
- Skill は `~/.claude/skills/mukuroji-review` に trusted な `origin/main` から導入し、
  レビュー開始前に `scripts/sync-review-skill.sh check claude` を **`origin/main` の版で**
  実行して一致を確かめる。一致しない場合はレビューを失敗扱いにして push しない。
- `AGENTS.md` の「手作業の編集は `apply_patch` を使う」は、Claude Code では Edit / Write
  ツールで代える。
