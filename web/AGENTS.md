# AGENTS.md

このファイルは `web/` 配下の作業に適用します。共通ルールはリポジトリルートの `AGENTS.md` に従ってください。

## 責務境界

- `src/pages/` は route parameter、認証、data fetch、mutation、navigation を組み立てる薄い container とする。
- 画面の描画責務は `src/<domain>/` に置き、複数の view、modal、form を持つ場合は同一 domain の `components/` または `views/` に分割する。
- filter、sort、集計、format などの React に依存しない処理は `presentation.ts` などの明示的な module に分離し、`test/` から直接検証できる形にする。
- domain の public component と type は小さな entry module から再 export し、route や Story が内部構成へ依存しないようにする。
- 表示文言は `src/i18n` から供給する。component 内に locale 固定の fallback 文言を追加しない。
- Story は描画対象 component を直接確認できるようにし、カテゴリは `Application/...` または `Design System/...` に揃える。
- E2E で共有する route stub、fixture、assertion helper は `e2e/support/` に置く。

## 検証

UI や画面構成を変更した場合は次を実行します。

```sh
bun run web:test
bun run web:lint
bun run web:build
bun run web:build-storybook
```

対象画面を起動できる場合は Storybook または E2E でも確認し、`storybook-static/` はコミットしません。
