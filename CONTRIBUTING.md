# コントリビューションガイド

mukuroji への変更（コード・文書・インフラ）を提案する人のための手順です。開発規約の本体は
[`AGENTS.md`](AGENTS.md) と、各 workspace の [`web/AGENTS.md`](web/AGENTS.md)・
[`server/AGENTS.md`](server/AGENTS.md) です。人が作業する場合も、コーディングエージェントが
作業する場合も同じ規約に従います。ここでは流れと検証コマンドをまとめます。

全体の構成は [アーキテクチャ概要](docs/architecture.md)、用語は [用語集](docs/glossary.md)、
画面の使い方は [利用者ガイド](docs/guide/README.md) を参照してください。

このリポジトリは [Apache License 2.0](LICENSE) で公開しています。PR として提出した変更は、
同ライセンスの第5条に従い Apache License 2.0 の下で提供されたものとして扱います。

## 1. Issue を確認・作成する

- 作業は Issue から始めます。既存の Issue を検索し、なければテンプレート
  （機能追加・改善 / 不具合 / タスク）から作成します。
- タイトルは `[P0]`〜`[P3]` の優先度で始めます。不具合は `[P2][Bug] ...` のように書きます。
- 本文は「背景 / 現状（根拠） / やること / 完了条件 / 依存・関連」の形式です。現状には
  確認したファイルと行番号を書き、推測とコードで確認した事実を区別します。
- **脆弱性は公開 Issue にしないでください。** [SECURITY.md](SECURITY.md) の非公開窓口を使います。

## 2. 開発環境を用意する

[README の「セットアップ」と「開発」](README.md#セットアップ) の手順で準備します。要点:

- Bun は `.bun-version` と同じ **1.3.10** を使い、依存はルートで `bun install` します。
  各 workspace に `bun.lock` を作らないでください。
- `bun run dev` で `.env` の用意、Floci、server・worker・Web の起動までをまとめて行います。
  止めるときは `Ctrl+C`、Floci も止めるときは `bun run dev:down` です。
- AWS が必要な動作はローカルのエミュレーター Floci で確認します。
  実 AWS アカウントへの deploy・migration・削除は maintainer の明示確認なしに行いません。
- `.env` は `bun run local:setup`（`bun run dev` も実行）が `.env.example` から作り、secret を生成して
  `chmod 600` にします。`.env` と `.floci/generated/` はコミットしません。

## 3. ブランチを切って実装する

- 作業を始める前に最新の `origin/main` を取り込みます。
- 変更は目的に対して小さく保ち、無関係な整形やリファクタリングを混ぜません。
- 規約の主なもの（詳細は `AGENTS.md`）:
  - TypeScript の exported 宣言・type / interface / class member には TSDoc を付け、
    関数とメソッドには英語の TSDoc を付ける
  - `as` による型 assertion と `any` は原則使わず、runtime validation や type guard を使う
  - `web`・`server`・`cdk` は互いの source を import せず、共有する型は `contracts` に置く
  - 循環依存や Knip の未使用検出は ignore で回避せず、依存方向を直す
- 設計判断を伴う変更は ADR を残します（[docs/adr/README.md](docs/adr/README.md)）。
- 利用者から見える挙動を変えたら、[利用者ガイド](docs/guide/README.md) の該当ページも更新します。

## 4. 検証する

変更した範囲に応じて実行し、結果を PR に書きます（`AGENTS.md` の「push 前チェック」と同じ）。

| 変更した範囲 | 実行するコマンド |
| --- | --- |
| すべて | `bun run oxc:lint`、`git diff --check` |
| `server/` | `bun run typecheck:server`、`bun run server:test`、Lambda entrypoint を変えたら `bun run server:build:lambda` |
| `web/` | `cd web && bunx tsc -b`、`bun run web:lint`、`bun run web:test`、`bun run web:build`、UI 変更は `bun run web:build-storybook` |
| `contracts/` | `bun run typecheck:contracts`、`bun run dependencies:check` |
| `cdk/` | `bun run cdk:build`、`bun run cdk:test`、可能なら `bun run cdk:synth` |
| ファイル配置・公開境界・エントリポイント | `bun run dependencies:check`、`bun run knip:check` |
| Public API | `bun run api:contract:check`（意図した変更なら `bun run api:contract:update`） |
| 画面の見た目 | `bun run web:e2e:desktop`、`bun run web:visual:docker`（[docs/web-quality-gates.md](docs/web-quality-gates.md)） |
| review Skill・`AGENTS.md` | `bun run skill:validate`、`bun run skill:validate:test` |

`tsc -p .` は web の `src` を検査しません。web の型検査は `cd web && bunx tsc -b` を使います。

## 5. Pull Request を出す

- PR はテンプレートに沿って書き、`Closes #123` で Issue と紐づけます。
- 作業が終わったら Draft ではなくレビューレディーで出します。
- レビュー bot の扱い:
  - **Codex**（`chatgpt-codex-connector[bot]`）は PR の作成と push で自動的にレビューします。
    最新 head に対する 👍 が必要です。P1 などのコメントは対応してから再確認します。
  - **CodeRabbit** は `@coderabbitai review` とコメントして開始します。無料枠の rate limit が
    厳しいため、修正はまとめて push し、レビュー中は push しないでください。
- CI は path filter で対象の workflow だけが走ります。対象の workflow がすべて成功するまで
  完了扱いにしません。main は「最新の main を含むこと」を必須にしているため、遅れている場合は
  main を取り込んでから再度 CI を待ちます。

### maintainer の承認が必要な変更

次のファイルは review の trust root です。変更する PR は maintainer が内容を確認し、
`review-ok:<head の完全な SHA>` label を付けるまで `Trusted review Skill validation` が失敗します
（`CODEOWNERS` にも記載しています）。

- すべての階層の `AGENTS.md`
- `.github/workflows/review-skill.yml`、`scripts/validate-mukuroji-review-skill.ts` とその test
- `.codex/skills/mukuroji-review/`

また `.github/workflows/` の変更は、GitHub App 経由の push が権限で拒否されることがあります。
その場合は maintainer が反映します。

## 6. マージ後

- 利用者向けの変更は、[利用者ガイド](docs/guide/README.md) と各 `docs/*.md` が最新か確認します。
- deploy の手順と確認は [docs/operational-readiness.md](docs/operational-readiness.md) に従います。
