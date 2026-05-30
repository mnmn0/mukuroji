# mukuroji

mukuroji は、プロジェクトやタスクの進捗をチームで見渡すための進捗管理アプリケーションです。

このリポジトリは Bun workspaces で構成されています。依存関係と lockfile はルートで管理します。

## 構成

- `web/`: React + TypeScript + Vite のフロントエンド
- `server/`: Hono + Bun の API サーバー
- `cdk/`: AWS CDK TypeScript プロジェクト
- `docs/`: ドキュメント

## セットアップ

```sh
bun install
```

Codex cloud のカスタムセットアップスクリプトには、以下を指定できます。

```sh
bash scripts/codex-setup.sh
```

検証まで実行したい場合は `CODEX_VALIDATE=1 bash scripts/codex-setup.sh` を使います。

## 開発

Floci + Cognito:

```sh
bun run floci:up
```

`4566` が既に使われている場合は host 側の port を変更できます。

```sh
FLOCI_PORT=4567 bun run floci:up
COGNITO_ENDPOINT=http://localhost:4567 bun run server:dev
```

Floci の ready hook がローカル Cognito を初期化します。作成されるテストユーザーは以下です。

- メールアドレス: `demo@example.com`
- パスワード: `Password123!`

API サーバーはデフォルトで `http://localhost:4566` の Floci Cognito に接続し、`mukuroji-local` ユーザープールと `mukuroji-web-local` クライアントを自動検出します。生成された値は `.floci/generated/cognito.env` に出力されます。

停止:

```sh
bun run floci:down
```

Web アプリ:

```sh
bun run web:dev
```

Storybook:

```sh
bun run web:storybook
```

API サーバー:

```sh
bun run server:dev
```

ローカルでログインまで確認する場合は、別ターミナルで以下を起動してください。

```sh
bun run floci:up
bun run server:dev
bun run web:dev
```

Web は Vite の proxy 経由で `/api` を `http://localhost:3000` に転送します。必要に応じて以下の環境変数を上書きできます。

- `VITE_API_BASE_URL`: ブラウザから呼ぶ API の base URL。未指定時は `/api`
- `VITE_API_PROXY_TARGET`: Vite dev server が proxy する API。未指定時は `http://localhost:3000`
- `COGNITO_ENDPOINT` / `AWS_ENDPOINT_URL`: API サーバーから見る Floci endpoint。未指定時は `http://localhost:4566`
- `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`: 明示指定する場合の Cognito リソース ID

## 検証

Web:

```sh
bun run web:lint
bun run web:build
bun run web:build-storybook
```

CDK:

```sh
bun run cdk:build
bun run cdk:test
bun run cdk:synth
```

## 依存管理

依存追加や更新はルートから実行してください。`bun.lock` はルートに集約し、各 workspace 配下には追加しません。

```sh
bun install
```

## エージェント向け補足

作業ルールは [AGENTS.md](./AGENTS.md) を参照してください。
