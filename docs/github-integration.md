# GitHub 連携（pull request のレビュー inbox）

GitHub App の webhook を合図に pull request の今の状態を読み直し、自分が作った pull request と
レビューを頼まれた pull request を一覧にします。設計の判断は [ADR 0079](adr/0079-github-app-pull-request-review-inbox.md) にあります。

GitHub App を作って secret を入れるまでは何も動きません。webhook は `404` を返し、毎時の reconcile は何もしません。

## 運用者の設定手順

deploy する人（Shinji）が1回だけ行います。

1 つの deploy は 1 つの Workspace（`MUKUROJI_WORKSPACE_DIRECTORY_ID`）だけを扱い、App もその Workspace 専用に作ります
（ADR 0079）。Workspace 管理者は App のすべての installation の repository を一覧し、link できるので、同じ App の秘密鍵を
別の Workspace の deploy と共有しないでください。App は、その Workspace の組織にだけ install します。

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
7. **repository を Team に link する**：Workspace 管理者が **設定** → **Workspace 管理** → **GitHub リポジトリ** で
   Team を選びます（API は `PUT /api/workspace/github/repositories/:repositoryId`、body `{"teamId": "..."}`）。
   link した repository の open な pull request はすぐに読み込まれます。
8. **member が GitHub login を登録する**：各 member が **設定** → **個人** → **GitHub** で登録します
   （API は `PUT /api/me/github-login`、body `{"githubLogin": "..."}`）。

### webhook secret を入れ替える

1. 新しい secret を `webhookSecret` に、古い secret を `previousWebhookSecret` に入れます。
2. Secrets Manager を更新してから 5 分以上待ちます（受け口は読んだ secret を 5 分キャッシュし、署名の不一致では読み直さないため、
   待たずに切り替えると古い secret だけを持つ Lambda が新しい署名を `401` で拒みます）。
3. GitHub App の Webhook secret を新しい値に変えます。
4. 新しい secret の webhook が `2xx` で届くのを Recent Deliveries で確かめてから `previousWebhookSecret` を消します。

## 受け口と同期

- `POST /api/integrations/github/webhook`：`X-Hub-Signature-256` を body の解析前に照合します（body は 5 MiB まで）。
  未設定は `404`、署名の不一致は `401`、壊れた body は `400`、大きすぎる body は `413`、`ping` は `200`、
  扱わない event は `202`（何もしない）、job を積めたら `202`、queue に積めなければ `503`。
  GitHub は失敗した delivery を自動では再送しません。`503`（や初期設定中に失敗した `ping`）は、App の Advanced →
  Recent Deliveries で該当する delivery を選び **Redeliver** で送り直します。毎時の reconcile は snapshot を直し、
  保存済みの pull request の変化（CI 失敗・conflict・レビュー依頼の追加）も通知しますが、初めて読む pull request の
  レビュー依頼は通知しません。取りこぼした新しい pull request の通知は再送でだけ戻ります。
- job は ID だけを持ちます。worker（`GitHubSyncFunction`）は link と installation が一致するときだけ、
  GraphQL で今の状態を読み直し、`syncedAt` が新しいときだけ snapshot を上書きします。
  - pull request 系の event：その番号を読む
  - check run・check suite・status：commit に紐づく pull request を読む
  - branch への push：その branch を base にする open な pull request を読む（conflict の再計算）
  - `mergeable` が未計算なら 30 秒×回数だけ遅らせて、最大 4 回読み直す
- `GitHubReconcileFunction` が 1 時間ごとに、link 済み repository の open な pull request と古い snapshot を読み直し、
  link を外した repository の snapshot と閉じて 30 日たった snapshot を消します。
  読み直した pull request の `mergeable` が未計算なら、webhook のときと同じく 30 秒後から読み直しの job を queue に入れます。
- Workspace が閉鎖中・閉鎖済みのとき、worker と reconcile は何も書きません（queue の job は捨てます）。
- 5 回失敗した job（再試行で直らない失敗も含む）、job として読めない message、再試行を使い切った reconcile は `GitHubSyncDlq` に入り、alarm が鳴ります。
  queue の最古の job が 15 分を超えたときも alarm が鳴ります。

## 受信箱の通知

worker は snapshot を書く前に、保存済みの snapshot と比べて次の通知を audit event として書きます。
collaboration projection がそれを受信箱の通知にし、届ける時点で受け手が link 先の Team を読めることを確かめます。

| event type | 受け手 | いつ |
| --- | --- | --- |
| `github.pull_request_review_requested` | 新しくレビューを頼まれた人 | open な pull request の reviewer に加わったとき |
| `github.pull_request_checks_failed` | 作成者 | CI が失敗に変わったとき、または新しい head commit で失敗したとき |
| `github.pull_request_conflict` | 作成者 | conflict のない状態から conflict に変わったとき（push の後で GitHub が計算し直している間の `unknown` は、その前の状態で比べます） |

- 受け手は登録済みの GitHub login で引きます。login を登録していない人には届きません。自分の操作は通知しません。
- 初めて読む pull request は、webhook が知らせたときだけ reviewer に通知します。repository の link と毎時の reconcile は
  通知しません（link した直後にすべての open な pull request が届かないようにするため）。
- event の ID は「比べた snapshot・変化の種類・受け手」から決まるので、再試行や重複した webhook で二重に届きません。
- audit log の summary には pull request の題名を書きません（題名は権限を確かめる通知の側だけに入ります）。
- 通知の deep link は `/reviews` です。
- 受信箱に入れるときと、メール・Slack・push で送る直前に、repository が今も同じ Team に link されているかを確かめます。
  link を外したり別の Team に移したりした後は、前の Team の人には届きません。
- 受信箱に入れるとき、その通知を見つけた読み取りより新しい snapshot が保存済みで、その snapshot がもう同じ変化（レビュー依頼・同じ commit の CI 失敗・同じ commit の conflict）を示していなければ、通知は捨てます（重なった同期の古い読み取りが、もう解消した失敗やコンフリクトを知らせないようにするため）。

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
- link の保存で最初の同期 job を queue に積めなかったときは `503` です。同じ request をもう一度送ると、link はそのままで job だけを積み直します。
- Enterprise の Team 単位の role で Team を読める member にも、その Team に link された repository の pull request が出ます。

## 保存する行

Planning table の Workspace の pk の下に置きます（新しい table はありません）。

| sort key | 内容 |
| --- | --- |
| `GITHUB_REPOSITORY#<repositoryId>` | repository と Team の link、installation、revision |
| `GITHUB_REPOSITORY_GENERATION#<repositoryId>` | link を外したときの最後の revision（もう一度 link すると続きの番号になり、古い画面からの変更を受け付けない） |
| `GITHUB_LOGIN#<小文字の login>` | login の持ち主（重複登録の防止） |
| `GITHUB_MEMBER#<member>` | member の login |
| `GITHUB_PULL_REQUEST#<repositoryId>#<番号>` | pull request の snapshot |

link と login の変更は audit event（`workspace.github_repository_linked` / `_unlinked`、`member.github_login_saved` / `_removed`）を
同じ transaction で書きます。login の event は login そのものを書かず、member の audit pseudonym だけで対象を示します。
