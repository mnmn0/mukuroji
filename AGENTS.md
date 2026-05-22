# AGENTS.md

このリポジトリで作業するエージェント向けのガイドです。より深い階層に別の `AGENTS.md` が追加された場合は、その内容を優先してください。

## 基本方針

- 変更前に関連コードを読み、既存の構成と命名に合わせる。
- ユーザーが明示的に頼んでいない既存変更は戻さない。
- 手作業の編集は `apply_patch` を使う。
- 検索はまず `rg` / `rg --files` を使う。
- 変更は目的に対して小さく保ち、無関係な整形やリファクタリングを混ぜない。
- コミット前にはサブエージェントレビューを受ける。
- コミットは意味のある粒度に分ける。

## ディレクトリ

- `web/`: React + TypeScript + Vite のフロントエンド。
- `server/`: Hono + Bun のサーバー。
- `cdk/`: AWS CDK TypeScript プロジェクト。
- `docs/`: ドキュメント置き場。

各パッケージは独立しているため、コマンドは対象ディレクトリに移動して実行してください。

## Web

`web/` は React 19, React Router, Tailwind CSS, Storybook を使います。

主なコマンド:

```sh
cd web
bun run dev
bun run lint
bun run build
bun run storybook
bun run build-storybook
```

実装方針:

- 画面単位のルーティングは `web/src/routes/router.tsx` に寄せ、`App.tsx` を肥大化させない。
- グローバル CSS は `web/src/index.css` を最小限に保ち、UI は Tailwind のユーティリティ中心で作る。
- Storybook のカテゴリは `Application/...` と `Design System/...` を基本にする。
- コンポーネントは Storybook で単体確認できるように Story を追加・更新する。
- 表示文言は i18n 対応を前提にし、固定文言をコンポーネントに閉じ込めない。
- 既存の `web/src/i18n.ts` と `createTranslator` / `createSidebarLabels` の方針に合わせる。
- ブランド表現には `BrandMark` と `mukuroji` 表記を使う。

確認:

- UI 変更では少なくとも `bun run lint`, `bun run build`, `bun run build-storybook` を通す。
- Storybook を起動できる場合は対象 Story をブラウザまたはスクリーンショットで確認する。
- Storybook の出力 `storybook-static/` は生成物なのでコミットしない。

## Server

`server/` は Hono + Bun です。

主なコマンド:

```sh
cd server
bun run dev
```

サーバー側はまだ小さいため、追加する際はルートの責務、入力検証、レスポンス形式を明確にしてください。

## CDK

`cdk/` は AWS CDK TypeScript プロジェクトです。

主なコマンド:

```sh
cd cdk
bun run build
bun run test
bun run cdk synth
```

インフラ変更では `bun run build` と `bun run test` を通し、可能なら `bun run cdk synth` で合成結果を確認してください。デプロイや AWS アカウントへ影響する操作はユーザーの明示確認を取ってください。

## コミット前チェック

作業内容に応じて必要な検証を実行し、結果をユーザーに伝えてください。

- `web` の UI/Storybook 変更: `bun run lint`, `bun run build`, `bun run build-storybook`
- `cdk` の変更: `bun run build`, `bun run test`
- `server` の変更: 利用可能なスクリプトと変更内容に応じて確認

コミット前レビューで指摘が出た場合は、対応してから再度必要な検証を行ってください。
