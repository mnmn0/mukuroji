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

## ディレクトリ

- `web/`: React + TypeScript + Vite のフロントエンド。Web 固有のルールは `web/AGENTS.md` に置く。
- `server/`: Hono + Bun のサーバー。
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
```

`oxc:lint:github` は GitHub Actions の annotation 向けです。CI / oxlint 設定を変更した場合は、ローカルでは通常 `bun run oxc:lint` を確認してください。

## Server

`server/` は Hono + Bun です。

主なコマンド:

```sh
bun run server:dev
```

サーバー側はまだ小さいため、追加する際はルートの責務、入力検証、レスポンス形式を明確にしてください。

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
- `server` の変更: 利用可能なスクリプトと変更内容に応じて確認

コミット前レビューで指摘が出た場合は、対応してから再度必要な検証を行ってください。
