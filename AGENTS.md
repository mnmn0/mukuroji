# AGENTS.md

このリポジトリで作業するエージェント向けのガイドです。より深い階層に別の `AGENTS.md` が追加された場合は、その内容を優先してください。

## 基本方針

- 変更前に関連コードを読み、既存の構成と命名に合わせる。
- ユーザーが明示的に頼んでいない既存変更は戻さない。
- 手作業の編集は `apply_patch` を使う。
- 検索はまず `rg` / `rg --files` を使う。
- 変更は目的に対して小さく保ち、無関係な整形やリファクタリングを混ぜない。
- TypeScript の exported 宣言には TSDoc を付ける。export 有無にかかわらず type / interface は宣言本体と各プロパティ、class は宣言本体とメンバー変数に TSDoc を付ける。
- コミット前にはサブエージェントレビューを受ける。
- コミットは意味のある粒度に分ける。
- 実装・修正作業を開始する前に、最新の `origin/main` をマージする。
- `gh` コマンドを実行する場合は、サンドボックス外で実行する。
- PR のレビューコメントに基づく変更を行った場合は、変更を push した後にレビューコメントへ返信する。

## ディレクトリ

- `web/`: React + TypeScript + Vite のフロントエンド。Web 固有のルールは `web/AGENTS.md` に置く。
- `server/`: Hono + Bun のサーバー。Server 固有のルールは `server/AGENTS.md` に置く。
- `cdk/`: AWS CDK TypeScript プロジェクト。
- `docs/`: ドキュメント置き場。

このリポジトリは Bun workspaces です。依存管理はルートで行い、lockfile はルートの `bun.lock` に集約します。各パッケージ配下に `bun.lock` を追加しないでください。

```sh
bun install
```

## 静的解析

Oxc / oxlint はリポジトリルートで設定します。

主なコマンド:

```sh
bun run oxc:lint
bun run oxc:lint:github
bun run typecheck:contracts
bun run typecheck:server
bun run dependencies:check
bun run knip:check
```

`oxc:lint:github` は GitHub Actions の annotation 向けです。CI / oxlint 設定を変更した場合は、ローカルでは通常 `bun run oxc:lint` を確認してください。

`typecheck:server` は server の本番コード、`typecheck:contracts` は共有 contract の型検査です。
`dependencies:check` は workspace 間の循環依存・禁止依存を、`knip:check` は未使用ファイル・依存を検査します。

## CDK

`cdk/` は AWS CDK TypeScript プロジェクトです。

主なコマンド:

```sh
bun run cdk:build
bun run cdk:test
bun run cdk:synth
```

インフラ変更では `bun run cdk:build` と `bun run cdk:test` を通し、可能なら `bun run cdk:synth` で合成結果を確認してください。デプロイや AWS アカウントへ影響する操作はユーザーの明示確認を取ってください。

## コミット前チェック

作業内容に応じて必要な検証を実行し、結果をユーザーに伝えてください。

- CI / oxlint 設定の変更: `bun run oxc:lint`
- `cdk` の変更: `bun run cdk:build`, `bun run cdk:test`

コミット前レビューで指摘が出た場合は、対応してから再度必要な検証を行ってください。
