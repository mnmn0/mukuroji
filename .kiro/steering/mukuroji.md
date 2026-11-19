---
inclusion: always
---

# mukuroji の規則

リポジトリの規則は `AGENTS.md` にあります。作業前に必ず読み、その内容に従ってください。

#[[file:AGENTS.md]]

## Kiro 固有の手順

- 環境の用意、push 前レビュー用 `mukuroji-review` Skill の導入と照合は
  `docs/coding-agents.md` に従う。
- Skill は `~/.kiro/skills/mukuroji-review` に trusted な `origin/main` から導入し、
  レビュー開始前に `scripts/sync-review-skill.sh check kiro` を `origin/main` の版で実行して
  一致を確かめる。一致した場合だけ、その `SKILL.md` と `references/` を読んでレビューする。
  一致しない場合はレビューを失敗扱いにして push しない。
- `AGENTS.md` の「手作業の編集は `apply_patch` を使う」は、Kiro では Kiro の編集ツールで代える。
