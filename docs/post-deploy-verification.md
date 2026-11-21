# 本番 deploy 後の確認

本番に deploy した直後に、動いていることを確かめる手順です。初回 deploy（[cdk/README.md の「最初に一度だけ行うこと」](../cdk/README.md#最初に一度だけ行うこと)）では
各段階の後に、2 回目からは `Deploy` の job が終わった後に行います。

Floci（AWS エミュレータ）では CloudFront、AppConfig の配信、Cognito の MFA、
内閣府 CSV の取得、SES の配信、STS の実呼び出しが本物と同じに動かないため、これらは本番で初めて確かめます。
下の [本番で初めて動くもの](#本番で初めて動くもの) に項目ごとの確かめ方をまとめています。

## smoke test

`scripts/post-deploy-smoke.ts` は stack output を読み、HTTP と AWS の読み取りだけで確認します。stack やデータは変えません。
`fail` が 1 つでもあれば exit code 1、`warn`（まだ時期が来ていないもの）だけなら 0 です。

```sh
AWS_REGION=ap-northeast-1 bun run deploy:smoke
```

`aws` CLI と bun がある端末で、`Mukuroji` stack を読める credential を使って実行します。CloudShell では
`curl -fsSL https://bun.sh/install | bash` で bun を入れ、repository を clone してから `bun install` します。
AWS の credential がない端末では、HTTP の確認だけを実行できます。

```sh
MUKUROJI_WEB_URL=https://dxxxx.cloudfront.net bun run deploy:smoke -- --skip-aws
```

| option / 環境変数 | 意味 |
| --- | --- |
| `--runtime enabled\|disabled\|read-only` | `/api/ready` と `/api/maintenance` に期待する mode。既定は `enabled` |
| `--expect-commit <SHA>` | `/api/health` と Web release に期待する 40 文字の commit。省くと `/api/health` が返した commit を使う |
| `--owner-email <email>` | 初期 owner。省くと SSM `/mukuroji/deploy/config/initial-owner-email` を読む |
| `--skip-aws` | AWS を呼ばず、`MUKUROJI_WEB_URL` に HTTP の確認だけを行う |
| `MUKUROJI_SMOKE_ACCESS_TOKEN` | owner の新しい access token。あると CloudFront と HTTP API の応答を比べる |
| `MUKUROJI_STACK_NAME` | stack 名。既定は `Mukuroji` |

### 初回 deploy で実行する時点

| 時点 | コマンド | 期待する結果 |
| --- | --- | --- |
| 手順 5（`Deploy` の承認）の後 | `bun run deploy:smoke -- --runtime disabled` | `fail` なし。`appconfig-deployment` は stack が作る最初の deployment（`disabled`）で `pass`、`owner-sign-in` は `FORCE_CHANGE_PASSWORD` で `warn` |
| 手順 6（`runtime-control-enable`）の後 | `bun run deploy:smoke` | `runtime-control` と `appconfig-deployment` が `pass` |
| 手順 7（owner のサインインと MFA）の後 | token を付けて `bun run deploy:smoke` | `owner-sign-in` と `authenticated-api` が `pass` |
| 有効化から 6 時間以内の次の UTC 0・6・12・18 時の後 | `bun run deploy:smoke` | `holiday-sync` が `pass` |

`cognito-email` は SES に切り替えるまで `warn` のままです（[SES](#ses-の招待メール635)）。
結果は job の summary と一緒に change record に貼ります。

### 確認項目

| 名前 | 見ていること | `fail` / `warn` のとき |
| --- | --- | --- |
| `stack` | stack が `CREATE_COMPLETE` か `UPDATE_COMPLETE` | CloudFormation の stack event で原因を見る |
| `web-root` / `spa-route` | `WebUrl` の `/` と `/login` が `index.html` を返す | `bun run web:deploy` が終わったか、CloudFront Function の書き換えを確認 |
| `cloudfront` | 応答に CloudFront の `Via` / `X-Cache` が付く | `WebUrl` が distribution を指しているか確認 |
| `web-security-headers` / `api-security-headers` | HSTS、`nosniff`、`DENY`、`no-referrer`、CSP。`/api/*` は `default-src 'none'` | response headers policy が behavior に付いているか確認 |
| `api-not-rewritten` | 存在しない `/api/*` が `index.html` でなく API の応答になる | `/api/*` の behavior と origin を確認 |
| `api-health` / `api-gateway-health` | CloudFront 経由と HTTP API 直接の `/api/health` が同じ commit を返す | deploy の job log で `cdk deploy` と alias の切り替えを確認 |
| `runtime-control` | `/api/ready` と `/api/maintenance` が期待した mode | 有効化の job が終わったか、`RuntimeControlConfigurationFailureAlarm` を確認 |
| `appconfig-deployment` | runtime control の最新 deployment が `COMPLETE` | `ROLLED_BACK` は alarm を確認してから再実行 |
| `web-bucket-private` | Web bucket を S3 から直接読むと 403 | bucket の public access block を確認 |
| `web-release` | `releases/<commit>/index.html` が残り、戻せる | `web:deploy` の log を確認 |
| `cognito-mfa` / `owner-sign-in` | user pool で TOTP が使え、owner が `CONFIRMED` で TOTP を登録済み | owner のサインインと Settings の MFA 設定を済ませる |
| `cognito-email` | Cognito の送信方法と SES の sandbox | [SES](#ses-の招待メール635) |
| `holiday-sync` | 内閣府の祝日一覧が今月（日本時間）分保存されている | 次の実行時刻を表示する。失敗が続くときは [祝日](#内閣府-csv-の祝日取得) |
| `dead-letter-queues` | stack の SQS queue のうち logical ID に `Dlq` か `DeadLetter` を含むもの（output のない DLQ も含む）がすべて空 | queue の message を見て原因を直す。DLQ は 14 日保持 |
| `alarms` | `Mukuroji-` で始まる alarm に `ALARM` がない | alarm の metric と log を確認 |
| `alarm-subscriptions` | alarm 用 SNS topic 2 つに確認済みの購読がある | SNS の確認メールで `Confirm subscription` を押す |
| `authenticated-api` | owner token で `/api/teams/projects`（CloudFront）、`/teams/projects` と `/api/teams/projects`（HTTP API）が同じ応答 | token が新しいか、Workspace の bootstrap を確認 |

owner の access token は、owner のパスワードと認証アプリのコードで取ります。パスワードを shell の履歴に残さないよう
`read -s` で読みます。

```sh
CLIENT_ID="$(aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name Mukuroji \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue | [0]" --output text)"
read -rs -p 'Password: ' OWNER_PASSWORD; echo
SESSION="$(aws cognito-idp initiate-auth --region "$AWS_REGION" --client-id "$CLIENT_ID" \
  --auth-flow USER_PASSWORD_AUTH --auth-parameters "USERNAME=$OWNER_EMAIL,PASSWORD=$OWNER_PASSWORD" \
  --query Session --output text)"
unset OWNER_PASSWORD
read -r -p 'Authenticator code: ' CODE
export MUKUROJI_SMOKE_ACCESS_TOKEN="$(aws cognito-idp respond-to-auth-challenge --region "$AWS_REGION" \
  --client-id "$CLIENT_ID" --challenge-name SOFTWARE_TOKEN_MFA --session "$SESSION" \
  --challenge-responses "USERNAME=$OWNER_EMAIL,SOFTWARE_TOKEN_MFA_CODE=$CODE" \
  --query AuthenticationResult.AccessToken --output text)"
AWS_REGION=ap-northeast-1 bun run deploy:smoke
unset MUKUROJI_SMOKE_ACCESS_TOKEN
```

## 本番で初めて動くもの

### CloudFront

- [ ] smoke test の `cloudfront`、`web-root`、`spa-route`、`api-not-rewritten`、`*-security-headers`、`web-bucket-private` が `pass`。
- [ ] browser で `WebUrl` を開き、開発者ツールの Console に CSP 違反が出ていない。WebSocket（`RealtimeWebSocketUrl`）と
      file bucket への接続が CSP で止められていない（Document を開く、file を添付する）。
- [ ] Help 画面の「稼働中の Web build」が deploy した commit と同じ。

### AppConfig の配信（runtime control）

- [ ] `runtime-control-enable` の job が `COMPLETE` で終わり、smoke test の `runtime-control` と `appconfig-deployment` が `pass`。
- [ ] job の間に `RuntimeControlConfigurationFailureAlarm` が `ALARM` にならなかった（smoke test の `alarms`）。
- [ ] API の log group に `runtime-control.evaluated` の record が出ている（[operational readiness](operational-readiness.md#dynamic-runtime-control)）。

### Cognito の MFA

- [ ] 初期 owner が仮パスワードでサインインし、新しいパスワードに変えた。
- [ ] Settings で認証アプリ（TOTP）を登録し、サインアウト後にコード付きでサインインできた。
- [ ] smoke test の `cognito-mfa` と `owner-sign-in` が `pass`。
- [ ] Workspace の security policy で MFA を必須にする場合は、TOTP のない member がサインイン時に登録を求められることを
      2 人目の member で確かめる。

### 内閣府 CSV の祝日取得

`ScheduledJobs` Lambda は runtime control を有効にした後、UTC の 0・6・12・18 時に内閣府の CSV を取りに行き、月に 1 回保存します
（[ADR 0032](adr/0032-japanese-public-holiday-monthly-sync.md)）。取得できない間は同梱の祝日を使うので、Work Item の作成は止まりません。
一覧は tenant administration table の `workspaceId = system#public-holidays`、`recordKey = JAPAN` の row です
（[docs/workspace-calendar-holidays.md](workspace-calendar-holidays.md#祝日データの出典と更新)）。

- [ ] 有効化の後の最初の実行時刻を過ぎてから、smoke test の `holiday-sync` が `pass`。
- [ ] `fail` や失敗回数が出るときは、`ScheduledJobsFunctionName` の log group で `"Scheduled job failed"` と
      `japanese-public-holiday-sync` を含む行を見る。内閣府の site の一時的な障害なら次の実行で取れる。
      1 回の実行で 2 回とも失敗すると、その event は `ScheduledJobsDlqUrl` に入る（smoke test の `dead-letter-queues`）。
- [ ] owner の token で `GET /api/workspace/calendar-settings` の `nationalHolidayDates` に今年の祝日が入っている。
      Gantt で祝日が網掛けされる。

### SES の招待メール（#635）

既定では Cognito が自分で送ります（1 日 50 通、送信元 `no-reply@verificationemail.com`）。手順は
[cdk/README.md の「招待と再設定のメールを SES から送る」](../cdk/README.md#招待と再設定のメールを-ses-から送る) です。

- [ ] 初期 owner に仮パスワードのメールが届いた（Cognito の既定の送信）。
- [ ] SES の identity を検証し、`CognitoEmailSender` を指定して deploy した。smoke test の `cognito-email` が `pass`
      （sandbox の間は `warn`）。
- [ ] 自分宛てに member を招待し、指定の送信元から招待メールが届いた。link が `WebUrl` の `/login` を指す。
- [ ] login 画面の「パスワードを忘れた場合」で確認コードが届いた。
- [ ] 通知 Email（`NotificationEmailSender`）を使う場合は、通知を 1 件起こして届くことを確かめる。
- [ ] 届かないときは SES の送信統計と suppression list を見る。

### データ移行の実 STS（#637）

`data:migrate:aws` の `--apply` は operator の credential で STS の presigned URL を作り、function がそれを STS に送って
実行者を確かめます（[docs/data-migration.md](data-migration.md)）。Floci では STS を本物どおりに試せていません。

- [ ] `bun run data:migrate:aws list --function-name <DataMigrationFunctionName>` が登録済みの migration を返す。
- [ ] 登録済みの migration があるときは、dry run → `--apply` → `verify` を 1 つ実行し、`--apply` が
      `OPERATOR_UNVERIFIED` にならず、checkpoint table の run record（`migrationId = RUN#<id>`）に自分の ARN が残る。
      新しい stack には移す row がほとんどないので、書き込みは 0 件か少数です。
- [ ] 登録済みの migration がまだなければ、最初の migration（下の Focus の backfill など）を実行するときに同じことを確かめる。

### Focus の担当者索引の backfill（#459）

PR #671（Focus を担当者索引から読む）を含む commit を deploy した後に行います。新しい stack では Work Item を作るときに
索引 row も書くので、初回 deploy の時点では backfill する row はありません。

- [ ] `bun run data:migrate:aws run --function-name <DataMigrationFunctionName> --migration 0001-work-item-member-index` の dry run。
- [ ] 同じ command に `--apply`。`paused`（exit 3）なら同じ command をもう一度実行して続きから再開する。
- [ ] `bun run data:migrate:aws verify --function-name <DataMigrationFunctionName> --migration 0001-work-item-member-index` が成功する。
- [ ] 担当の Work Item が Focus に出る。

## 画面で確かめること

- [ ] サイドバーの「チームを追加」で最初の Team を作り、Project と Work Item を 1 件ずつ作れる。
- [ ] 2 つの browser で同じ Document を開き、片方の変更がもう片方に届く（WebSocket）。
- [ ] 作った Work Item を削除し、Team と Project も不要なら片付ける。
