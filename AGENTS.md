# AGENTS.md

このリポジトリで作業するエージェント向けのガイドです。より深い階層に別の `AGENTS.md` が追加された場合は、その内容を優先してください。

## 基本方針

- 変更前に関連コードを読み、既存の構成と命名に合わせる。
- ユーザーが明示的に頼んでいない既存変更は戻さない。
- 手作業の編集は `apply_patch` を使う。
- 検索はまず `rg` / `rg --files` を使う。
- 変更は目的に対して小さく保ち、無関係な整形やリファクタリングを混ぜない。
- TypeScript の exported 宣言には TSDoc を付ける。export 有無にかかわらず type / interface は宣言本体と各プロパティ、class は宣言本体とメンバー変数に TSDoc を付ける。
- Add English TSDoc to functions and methods by default, including non-exported helpers introduced by a change. Exported declarations must describe their purpose and document parameters and return values when applicable; keep type, interface, and class member documentation complete.
- Avoid TypeScript `as` assertions by default because they can hide invalid data at type boundaries; prefer runtime validation, type guards, or explicit construction of typed values.
- Avoid `any` by default. Use `unknown` with narrowing or a specific type, and document a narrowly scoped exception when `any` is unavoidable.
- push 前にはサブエージェントレビューを受ける。レビュー時はtrustedなdefault branchから同期された `mukuroji-review` Skill を使い、Issue と変更領域に応じたレビュー観点を選択する。Skillや `AGENTS.md` 自体を変更する場合は、変更前のtrustedなSkill・ルールを使ってレビューする。
- コミットを分けること自体を目的にせず、関連する変更はまとめてよい。レビューは push 前に一度行う。
- 実装・修正作業が完了し、必要な検証と push 前レビューが成功したら、ユーザーが明示的に不要または Draft を指定しない限り、Draft ではなくレビューレディーの PR を作成する。
- 実装・修正作業を開始する前に、最新の `origin/main` をマージする。
- `gh` コマンドを実行する場合は、サンドボックス外で実行する。
- PR のレビューコメントに基づく変更を行った場合は、変更を push した後にレビューコメントへ返信する。

## ディレクトリ

- `web/`: React + TypeScript + Vite のフロントエンド。Web 固有のルールは `web/AGENTS.md` に置く。
- `server/`: Hono + Bun のサーバー。Server 固有のルールは `server/AGENTS.md` に置く。
- `contracts/`: Web / Server / CDK で共有する TypeScript の契約。公開面は `contracts/src/index.ts` に集約する。
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

### Workspace の依存境界

- `web`、`server`、`cdk` は互いの source を直接 import しない。共有する request / response / value type は `contracts` が所有する。
- `contracts` は consumer である `web`、`server`、`cdk` に依存せず、runtime や infrastructure の実装を持ち込まない。
- `web`、`server`、`cdk` から `contracts` への依存だけを workspace 間の共有契約として許可する。
- これらの方向は `.dependency-cruiser.cjs` に全方向を明示し、workspace を追加した場合は同じ検査へ組み込む。

### `dependencies:check` / `knip:check` の修正方針

- 循環依存は ignore で回避せず、型・定数・純粋関数を所有する下位モジュールへ移して依存方向を揃える。
- `index.ts` などの公開用 barrel を、同じ領域の内部モジュールから逆参照しない。内部では具体的な sibling module を参照する。
- Knip の未使用ファイルは `rg` とエントリポイントを確認し、不要な旧実装なら削除し、実際に必要なエントリポイントなら設定へ明示する。
- ignore / exclude の追加は、生成物や外部から呼ばれるエントリポイントなど、静的解析で追跡できない明確な理由がある場合に限定する。

## Contracts

- `contracts/src/index.ts` はパッケージ外部向けの公開用 barrel とし、契約の実体は `contracts/src/<domain>.ts` に置いて re-export する。
- `contracts/src/<domain>.ts` から `./index` を import しない。契約同士の依存は、所有元となる具体的な domain module を直接参照する。
- 汎用的な `types.ts` や `types/` に集約せず、型を所有するドメイン名のファイルへ配置する。
- Contracts を変更した場合は、少なくとも `bun run typecheck:contracts` と `bun run dependencies:check` を確認する。

## CDK

`cdk/` は AWS CDK TypeScript プロジェクトです。

主なコマンド:

```sh
bun run cdk:build
bun run cdk:test
bun run cdk:synth
```

TypeScript のコンパイル生成物は `cdk/dist/` に出力し、ソースファイルと同じ場所へ `.js` / `.d.ts` を生成しないでください。隣接する生成物はモジュール解決や Knip の解析対象を曖昧にします。`dist/` と `cdk.out/` は生成物として追跡しません。

インフラ変更では `bun run cdk:build` と `bun run cdk:test` を通し、可能なら `bun run cdk:synth` で合成結果を確認してください。デプロイや AWS アカウントへ影響する操作はユーザーの明示確認を取ってください。

## push 前チェック

作業内容に応じて必要な検証を実行し、結果をユーザーに伝えてください。

- CI / oxlint 設定の変更: `bun run oxc:lint`
- Contracts の変更: `bun run typecheck:contracts`, `bun run dependencies:check`
- ファイル配置・公開境界・エントリポイントの変更: `bun run dependencies:check`, `bun run knip:check`
- `cdk` の変更: `bun run cdk:build`, `bun run cdk:test`

push 前レビューで指摘が出た場合は、対応してから再度必要な検証を行ってください。
