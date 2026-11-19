## 概要

<!-- 何を、なぜ変えたか。関連 Issue を `Closes #123` / `Refs #123` で書いてください。 -->

Closes #

## 変更内容

-

## 確認したこと

<!-- AGENTS.md の「push 前チェック」から、変更に応じて実行したコマンドと結果を残してください。 -->

- [ ] `bun run oxc:lint`
- [ ] 型検査（`bun run typecheck:server` / `bun run typecheck:contracts` / `cd web && bunx tsc -b`）
- [ ] テスト（`bun run server:test` / `bun run web:test` / `bun run cdk:test`）
- [ ] `bun run dependencies:check` / `bun run knip:check`（ファイル配置・公開境界を変えた場合）
- [ ] UI 変更は Storybook またはスクリーンショットで確認した
- [ ] AWS が必要な動作はローカルの Floci で確認した

## 未確認・影響範囲

<!-- 確認できなかったこと、deploy・migration・backfill の要否、権限・認証・tenant 境界への影響。 -->

## レビュー

- [ ] Codex（`chatgpt-codex-connector[bot]`）の 👍 を最新 head で確認した
- [ ] `@coderabbitai review` で CodeRabbit を開始し、最新 head で actionable comment なしの `Review finished` と `CodeRabbit` check の成功を確認した
- [ ] 適用対象の CI workflow がすべて成功した
- [ ] `AGENTS.md`・`.github/workflows/`・review Skill を変える（maintainer の承認が必要）
