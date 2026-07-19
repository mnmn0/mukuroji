# Server の開発ガイド

このファイルは `server/` 配下の作業に適用します。リポジトリ全体の方針はルートの `AGENTS.md` に従い、server はこの理想構成を基準に実装します。

## 目的

Hono の HTTP transport、業務ルール、AWS/DynamoDB などの外部接続を分離し、各業務モジュールを独立して理解・テストできる構成にします。

- domain は純粋な TypeScript として保つ
- application は use case と transaction の境界を持つ
- adapter-in は入力変換と transport に集中する
- adapter-out は AWS など外部システムへの接続を担当する
- app は各モジュールを組み立てるだけにする

## コマンド

```sh
bun run server:dev
bun run server:test
bun run server:build:lambda
bun run oxc:lint
```

変更内容に応じて、少なくとも次を確認します。

- API・業務ロジック: `bun run server:test`
- Lambda entrypoint: `bun run server:build:lambda`
- TypeScript・lint・共有 contract: `bun run oxc:lint`

AWS account、Lambda、DynamoDB、S3、Secrets Manager に影響する deploy、backfill、migration、削除は、ユーザーの明示確認なしに実行しません。

## ディレクトリ構造

```text
server/
├── src/
│   ├── app/
│   │   ├── createApp.ts
│   │   ├── composition/
│   │   ├── routes/
│   │   ├── middleware/
│   │   └── error-handler.ts
│   ├── modules/
│   │   └── <domain>/
│   │       ├── domain/
│   │       ├── application/
│   │       │   ├── ports/
│   │       │   └── use-cases/
│   │       ├── adapter-in/
│   │       │   ├── http/
│   │       │   ├── events/
│   │       │   └── schedules/
│   │       ├── adapter-out/
│   │       │   ├── dynamodb/
│   │       │   ├── cognito/
│   │       │   ├── s3/
│   │       │   └── secrets-manager/
│   │       ├── errors.ts
│   │       └── index.ts
│   ├── infrastructure/
│   │   ├── aws/
│   │   ├── config/
│   │   └── observability/
│   └── handlers/
│       ├── api.handler.ts
│       ├── stream.handler.ts
│       └── schedule.handler.ts
├── scripts/
│   └── backfills/
└── package.json
```

### 各ディレクトリの責務

- `app/`: Hono app、route 登録、middleware、共通 error handler の組み立て
- `app/composition/`: concrete adapter を生成し、application port へ注入する唯一の composition root
- `modules/<domain>/domain/`: entity、value object、不変条件、domain service
- `modules/<domain>/application/`: use case、認可済み command、transaction orchestration
- `modules/<domain>/application/ports/`: application が要求する外部接続 interface
- `modules/<domain>/adapter-in/`: HTTP/event/schedule の入力変換と use case 呼び出し
- `modules/<domain>/adapter-out/`: DynamoDB、Cognito、S3、Secrets Manager の実装
- `infrastructure/`: 業務知識を持たない AWS client、環境設定、ログ・metrics
- `handlers/`: Lambda event を adapter-in へ渡す薄い entrypoint
- `scripts/backfills/`: idempotent な backfill、dry-run、checkpoint 処理

`utils`、`services`、`helpers`、`misc` のような所有者不明の汎用ディレクトリは作りません。処理の所有者である domain module の中へ置きます。

## 依存方向

```text
app/composition ──→ adapter-in
       │
       ├───────────→ application ──→ domain
       │                    ↑
       └───────────→ adapter-out ───┘
                         implements application/ports
```

次の依存を禁止します。

- `domain/` から Hono、AWS SDK、`process.env`、HTTP context への依存
- `application/` から Hono context や AWS SDK への直接依存
- `app/composition/` 以外で concrete adapter を use case へ注入する依存
- `adapter-in/` から DynamoDB command、AWS SDK、table key への直接依存
- `adapter-out/` から Hono、HTTP response、UI 表現への依存
- module の内部実装を別 module から直接 import する依存
- `scripts/` から route handler を呼び出す依存

他モジュールが利用するものは `modules/<domain>/index.ts` から明示的に公開します。内部 class、DynamoDB item、AWS response を module の公開 API にしません。

## HTTP API

- canonical path は `/api` prefix 付きにする
- Bun server と Lambda で同じ Hono app / route contract を使う
- Lambda adapter の path normalization 契約を壊さない
- auth middleware は `application/ports` の `PrincipalResolver` / `Authenticator` を通じて現在の principal を解決し、Hono context へ渡す
- route handler は path/query/header/body の取得、context からの principal 取得、use case 呼び出し、response 変換だけを担当する
- route handler に業務計算、DynamoDB transaction、AWS SDK 呼び出しを置かない
- request body、query、path、header はすべて untrusted input として扱う
- `unknown` から runtime validation、normalization を行い、検証済み input を use case に渡す
- response は安定した JSON shape と HTTP status を返す
- DynamoDB の physical key、内部 cursor、AWS SDK response、stack trace を response に返さない
- 共有する request/response DTO は `@mukuroji/contracts` を優先する

## 認証・認可・security

- 保護された route は `Authorization: Bearer <token>` を要求する
- Cognito token 検証後に、現在の user、Workspace、directory、group を server 側で解決する
- client が送る user ID、role、Workspace ID、membership、project/team access を認可根拠として信頼しない
- system admin の bypass も現在の Cognito membership と server-side state を再検証する
- public endpoint は明示的な allowlist とし、protected route の認証・認可を不用意に迂回しない
- secret、password、token、HMAC key、signing secret、presigned URL、raw webhook body をログに出さない
- PII や identifier の audit/log 保存は redaction または pseudonym 方針に従う
- 外部 URL へ接続する処理は HTTPS、hostname allowlist、timeout、body size、redirect、SSRF を検証する

認証と認可は HTTP 層だけでなく、use case の境界でも scope と権限を確認します。

## Error boundary

domain/application は HTTP や AWS の型を知らず、stable な error code と error category だけを返します。HTTP status への変換は `adapter-in` または共通 error handler が担当し、AWS SDK error の分類は adapter-out が担当します。

- validation、authentication、authorization、not found を区別する
- revision conflict、idempotency conflict、upstream failure、transient infrastructure failure を区別する
- client が message の文字列一致に依存しないよう、code を返す
- adapter-out は AWS SDK error、DynamoDB conditional failure、AWS/永続化データの parse error を application が扱える error port/type へ分類する
- adapter-in は HTTP request body、query、path の parse/validation error を application が扱える input error へ分類する
- transaction cancellation をすべて generic conflict に変換しない
- unexpected error は correlation ID 付きで内部ログへ記録し、外部には安全な generic error を返す
- error を握りつぶして空データ、成功、batch skip として扱わない

共通 error handler は error category/code から response の形式と HTTP status を統一し、secret、stack trace、raw AWS error、個人情報を外へ漏らしません。

## DynamoDB と transaction

- partition key、sort key、scope key、record key は server が canonical ID と scope から構築する
- client から受け取った physical key、table name、S3 object key をそのまま使わない
- authorization、canonical record、revision、relation graph に使う read は、必要に応じて strongly consistent read にする
- Query/Scan は `LastEvaluatedKey` を処理し、ページを黙って捨てない。上限到達を成功として隠さない
- mutation は `expectedRevision`、condition expression、または同等の CAS で stale write を拒否する
- validation 後に変更され得るデータは transaction condition で再検証する
- canonical row、projection、audit/outbox、receipt の transaction 境界を明示する
- transaction failure は validation、conflict、not found、retryable infrastructure error に分類する
- unknown schema、scope 不一致、壊れた永続化 row は skip せず fail-closed にする

audit の schema、redaction、retention は [docs/event-audit.md](../docs/event-audit.md)、Work Item の canonical schema は [docs/work-items.md](../docs/work-items.md) に従います。

## Idempotency と background processing

- retry される mutation、Webhook、stream、schedule は idempotent にする
- `Idempotency-Key` は operation、scope、入力 fingerprint に束縛する
- 同じ key の異なる入力は conflict とする
- 応答消失後の retry は deterministic ID または durable receipt で既存成功を検出する
- retry は一時障害に限定し、validation、permission、revision conflict を自動 retry しない
- correlation ID と audit context を logical mutation 全体で維持する
- stream handler は record 単位の parse/process と partial batch failure を実装する
- schedule handler は due 判定、lease、revision、重複実行、再実行時 ID を検証する
- malformed event を成功扱いで捨てず、DLQ/failure 方針に従う
- backfill は HTTP 層を経由しなくてもよいが、IAM 等で実行主体を認証し、対象 scope を限定した system/operator principal を application use case または専用 backfill service に渡す。domain rule、transaction、audit を再利用し、実行者と scope を audit に記録する

domain 固有の契約は [docs/automation.md](../docs/automation.md)、[docs/request-intake.md](../docs/request-intake.md)、[docs/file-proofing.md](../docs/file-proofing.md) に従います。

## AWS adapter

- AWS client は `application/ports` の interface 越しに利用する
- client、table name、endpoint、secret prefix は `infrastructure/config` の設定から取得する
- local table bootstrap は local development に限定する
- private S3 object は短命 presigned URL と scan 状態を経由して公開する
- malware scan、immutable version、delete/quarantine の順序を壊さない
- Secrets Manager の plaintext secret は必要な処理の memory 内に限定し、response、DynamoDB、audit、ログへ保存しない
- AWS adapter で domain rule を判断せず、必要な状態を application へ返す

## テスト

各 module は domain/application/adapter-in/adapter-out の境界を意識してテストします。

- domain は AWS/Hono なしの純粋な unit test にする
- application は fake port を注入し、認可、transaction、revision、idempotency を検証する
- adapter-in は request parsing、validation、auth、response/error mapping を検証する
- adapter-out は AWS SDK command、key、condition、pagination、transaction item を検証する
- stream/schedule/Webhook は malformed input、部分失敗、再配送、重複実行を検証する
- 実際の AWS account、外部 network、secret を使う test を通常の test command に含めない
- backfill は dry-run、limit、checkpoint、再実行安全性、unknown row を検証する

テストは対象 module の近くに置き、`bun run server:test` で全体を実行します。API contract や `@mukuroji/contracts` を変更した場合は Web 側の test/build も確認します。

## TypeScript

- `strict` を維持する
- exported declaration には TSDoc を付ける
- export 有無にかかわらず `type` / `interface` は宣言本体と各プロパティに TSDoc を付ける
- `class` は宣言本体とメンバー変数に TSDoc を付ける
- `any` は新規コードで使わない。外部入力、AWS response、event payload は `unknown` から検証する
- 検証なしの `as` で request、AWS response、永続化 row を信頼しない
- `catch` の error は `unknown` として各層の error type へ分類し、下位層の raw error を上位層や response へ漏らさない
- ログには correlation ID を付け、secret、token、raw body、個人情報を含めない

## 実装手順

1. 対象 module の use case、認証・認可、入力、response、error contract を整理する
2. domain rule と application use case を定義する
3. application port を定義し、AWS adapter を後から実装する
4. HTTP/event adapter は validation 済み input を use case に渡すだけにする
5. transaction、revision、idempotency、retry、audit/outbox の境界をテストする
6. `bun run server:test`、`bun run server:build:lambda`、必要に応じて `bun run oxc:lint` を実行する
7. route、共有 contract、環境変数、業務仕様を変更した場合は README/docs と Web 側の利用箇所を更新する
