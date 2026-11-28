# GitHub 連携（pull request のレビュー inbox）

GitHub App の webhook を合図に pull request の今の状態を読み直し、自分が作った pull request と
レビューを頼まれた pull request を一覧にします。設計の判断は [ADR 0079](adr/0079-github-app-pull-request-review-inbox.md) にあります。

GitHub App を作って secret を入れるまでは何も動きません。webhook は `404` を返し、毎時の reconcile は何もしません。

## 運用者の設定手順

deploy する人（Shinji）が1回だけ行います。

1. **stack に module を足す**：`-c mukuroji:githubApp=true` を付けて deploy します（`cdk.json` の context に書いても同じ）。
   出力 `GitHubAppWebhookUrl`（`https://<アプリの origin>/api/integrations/github/webhook`）と `GitHubAppSecretArn` を控えます。
2. **GitHub App を作る**：GitHub の Settings → Developer settings → GitHub Apps → New GitHub App。
   - Homepage URL：アプリの origin
   - Webhook：Active にし、URL は手順 1 の `GitHubAppWebhookUrl`。Secret は 20 文字以上の乱数（例：`openssl rand -hex 32`）
   - Repository permissions（すべて Read-only）：Pull requests、Checks、Commit statuses、Contents、Metadata
   - Subscribe to events：Pull request、Pull request review、Pull request review comment、Pull request review thread、
     Check run、Check suite、Status、Push
   - Where can this GitHub App be installed?：Only on this account
3. **秘密鍵を作る**：App の画面の「Generate a private key」で PEM をダウンロードします（RSA 鍵）。
4. **App を install する**：App の「Install App」から、使う repository を選んで install します。
5. **secret を入れる**：App ID（App の画面の「App ID」、数字）と手順 2・3 の値を、JSON で入れます。

   ```sh
   jq -n --arg appId "123456" --rawfile privateKey ./app.private-key.pem --arg webhookSecret "<手順2の secret>" \
     '{appId: $appId, privateKey: $privateKey, webhookSecret: $webhookSecret}' > github-app.json
   aws secretsmanager put-secret-value --secret-id "<GitHubAppSecretArn>" --secret-string file://github-app.json
   rm github-app.json ./app.private-key.pem
   ```

   値は 5 分以内にすべての Lambda に反映されます。足りない項目や RSA でない鍵を入れると、各 runtime は
   `GitHubAppCredentialsInvalid` で失敗します（placeholder に戻せば「未設定」に戻ります）。
6. **届くか確かめる**：App の Advanced → Recent Deliveries の `ping` が `200` なら受け口は動いています。
7. **repository を Team に link する**：Workspace 管理者が `PUT /api/workspace/github/repositories/:repositoryId`
   （body `{"teamId": "..."}`）で link します。管理画面は続く PR で足します。link した repository の open な
   pull request はすぐに読み込まれます。
8. **member が GitHub login を登録する**：各 member が `PUT /api/me/github-login`（body `{"githubLogin": "..."}`）で登録します。

### webhook secret を入れ替える

新しい secret を `webhookSecret` に、古い secret を `previousWebhookSecret` に入れてから GitHub App の Webhook secret を
変えます。届く webhook がすべて新しい secret になったら `previousWebhookSecret` を消します。

## 受け口と同期

- `POST /api/integrations/github/webhook`：`X-Hub-Signature-256` を body の解析前に照合します（body は 5 MiB まで）。
  未設定は `404`、署名の不一致は `401`、壊れた body は `400`、大きすぎる body は `413`、`ping` は `200`、
  扱わない event は `202`（何もしない）、job を積めたら `202`、queue に積めなければ `503`（GitHub が再送します）。
- job は ID だけを持ちます。worker（`GitHubSyncFunction`）は link と installation が一致するときだけ、
  GraphQL で今の状態を読み直し、`syncedAt` が新しいときだけ snapshot を上書きします。
  - pull request 系の event：その番号を読む
  - check run・check suite・status：commit に紐づく pull request を読む
  - branch への push：その branch を base にする open な pull request を読む（conflict の再計算）
  - `mergeable` が未計算なら 30 秒×回数だけ遅らせて、最大 4 回読み直す
- `GitHubReconcileFunction` が 1 時間ごとに、link 済み repository の open な pull request と古い snapshot を読み直し、
  link を外した repository の snapshot と閉じて 30 日たった snapshot を消します。
- 5 回失敗した job と、再試行を使い切った reconcile は `GitHubSyncDlq` に入り、alarm が鳴ります。
  queue の最古の job が 15 分を超えたときも alarm が鳴ります。

## API

| Method | Path | 権限 | 内容 |
| --- | --- | --- | --- |
| GET | `/api/me/pull-requests?view=to-review\|created` | Workspace の閲覧 | 自分のレビュー inbox |
| GET / PUT / DELETE | `/api/me/github-login` | Workspace の閲覧 | 自分の GitHub login |
| GET | `/api/workspace/github/repositories` | Workspace 管理 | App が読める repository と link |
| PUT | `/api/workspace/github/repositories/:repositoryId` | Workspace 管理 | Team に link（`expectedRevision` で競合を検出） |
| DELETE | `/api/workspace/github/repositories/:repositoryId?expectedRevision=` | Workspace 管理 | link を外す |
| DELETE | `/api/workspace/github/logins/:login` | Workspace 管理 | 他人が登録した login を外す |

- inbox は、閲覧者が読める Team に link された repository の pull request だけを返します。
  `created` は自分が作ったもの、`to-review` は他人が作った open なもののうち、自分がレビューを頼まれたか、すでにレビューしたものです。
- 各 item は section（`ready-to-merge`・`open`・`merged`・`closed`）、CI の状態と失敗した check の名前（最大 20）、
  conflict の有無、レビューの判定を持ちます。`ready-to-merge` は draft でなく、conflict がなく、CI が通り（または check がなく）、
  承認済みかレビュー不要のものです。
- GitHub login は 1 つの login を 1 人だけが登録できます（大文字・小文字は区別しません）。他人が登録済みなら `409`。
- App が未設定のとき、inbox は `configured: false` を返し、link の変更は `409` です。

## 保存する行

Planning table の Workspace の pk の下に置きます（新しい table はありません）。

| sort key | 内容 |
| --- | --- |
| `GITHUB_REPOSITORY#<repositoryId>` | repository と Team の link、installation、revision |
| `GITHUB_LOGIN#<小文字の login>` | login の持ち主（重複登録の防止） |
| `GITHUB_MEMBER#<member>` | member の login |
| `GITHUB_PULL_REQUEST#<repositoryId>#<番号>` | pull request の snapshot |

link と login の変更は audit event（`workspace.github_repository_linked` / `_unlinked`、`member.github_login_saved` / `_removed`）を
同じ transaction で書きます。
