# 0113. Slack の channel の発言を社内 Slack app の Events API で受け、Team / Project に対応づけて保存する

- 状態: 提案
- 日付: 2026-11-28
- 関連: Issue #828、ADR 0086（Slack 送信先）、`docs/external-chat-sync.md`

## 背景

Mukuroji に「Slack で話したことを聞けば答えが返る」ようにするには（#829）、Slack の会話を
読み取り専用の写しとして Mukuroji に持つ必要がある。これまで Slack は通知の送信先
（Incoming Webhook、ADR 0086）としてだけ使っていて、Slack から読む経路はなかった。
`docs/external-chat-sync.md` の external-chat は thread と Work Item の双方向同期の contract と
永続化だけで、channel 全体の取り込みは扱わない。

Slack はどの情報の正本にもしない。決まったことは意思決定ログ（#830）や Work Item に移す。
取り込みは検索と回答の材料で、閲覧権限は Mukuroji 側の Team / Project に従わせる。

## 決定

### Slack app と設定

- 社内向けの Slack app を 1 つ作り、Mukuroji の 1 つの Workspace に結びつける。Marketplace には出さない
  （社内 app は `conversations.history` が Tier 3 の rate limit のまま使える。2025-05-29 以降、
  Marketplace 外で配布する商用 app は 1 分に 1 回・15 件に制限されたが、社内 app は対象外）。
- 設定は Secrets Manager の secret `mukuroji/slack-ingest` 1 つに JSON で置く:
  `signingSecret`、`botToken`（`xoxb-`）、`teamId`、`workspaceId`（結びつける Mukuroji の Workspace）、
  任意で `appId`。stack は secret を作らず、名前を決めて読む権限だけを持つ。secret がない環境では
  受け口は 404 を返し、worker は何もしない（Secrets Manager は secret 1 つで月 $0.40）。
- 必要な bot scope は `channels:history`、`groups:history`、`channels:read`、`groups:read`、`users:read`。
  購読する bot event は `message.channels`、`message.groups`、`member_joined_channel`、`channel_left`、
  `group_left`。DM（`im`）と group DM（`mpim`）は購読せず、届いても捨てる。

### 受け口と queue

- `POST /api/public/slack/events` を API Lambda に足す。サインインは不要で、Slack の
  `X-Slack-Signature`（`v0:` + timestamp + 生の body の HMAC-SHA256）を signing secret で
  定数時間比較し、`X-Slack-Request-Timestamp` が 5 分より古いか新しすぎる要求は 401 にする。body は 256 KiB まで。
- `url_verification` には challenge を返す。`event_callback` は `team_id`（と設定があれば `api_app_id`）が
  secret と一致するときだけ受け、Workspace が active かを確かめ、正規化した event を SQS
  `SlackIngestQueue` に入れて 200 を返す。Slack は 3 秒以内の応答を求めるので、受け口では Slack API を呼ばない。
  再送（`X-Slack-Retry-Num`）も同じく入れる。worker の書き込みは同じ event を何度処理しても結果が同じになる。
- worker（`SlackIngestFunction`、SQS、batch 1、partial batch failure）が event・過去分の読み込み・削除の
  3 種類の job を処理する。Slack の 429 は `Retry-After` 秒（最大 900 秒）遅らせて同じ job を入れ直す。
  5 回失敗した job は DLQ に移り、alarm を出す。

### 保存 key

DeveloperPlatformTable（`workspaceId` + `recordKey`、TTL `expiresAt`）の Workspace の partition に置く。
Workspace の export と削除は既存の developer-platform の対象に入る。

| row | `recordKey` | 中身 |
| --- | --- | --- |
| 設定 | `slack-ingest#settings` | 保持日数、revision |
| 接続 | `slack-ingest#installation` | Slack team の URL、bot user ID、確認時刻 |
| channel | `slack-ingest#channel#<channelId>` | 名前、private か、bot が参加中か、対応先、対応の revision、過去分読み込みの状態 |
| 発言 | `slack-ingest#message#<channelId>#<ts>` | thread の `ts`、発言者 ID と表示名、本文（最大 8,000 文字）、Work Item key、permalink、版、`expiresAt` |
| key 索引 | `slack-ingest#key#<Work Item key>#<ts>#<channelId>` | 発言を Work Item key から新しい順に引く。`expiresAt` は発言と同じ |
| 発言者 | `slack-ingest#user#<userId>` | 表示名の cache（7 日で TTL） |

- 編集は版（`edited.ts`、なければ `ts`）が新しいときだけ上書きする条件付き書き込みにし、順不同に届いても戻らない。
- 削除は本文を消した tombstone に置き換え（1 日で TTL）、後から古い版が届いても復活させない。key 索引も消す。
- bot の発言（`bot_id` 付き、`bot_message`）と参加・退出などの system message は保存しない。
  Mukuroji 自身の通知を写し直さないため。

### channel の対応づけと権限

- 管理者（Workspace の owner / admin）が Workspace 設定で「channel → Team」または「channel → Project」を
  対応づける。channel は bot が招待されたときに一覧に出る。対応づけのない channel の発言は保存しない。
  private channel もこの明示的な対応づけでだけ取り込み、一覧で private と分かるようにする。
- 発言の閲覧権限は、読むときの channel の対応先に従う。Team なら Team の viewer、Project なら
  その Project の viewer。対応先を変えると、保存済みの発言もすぐ新しい対応先の権限で読まれる。
- 対応を外すと、その channel の保存済みの発言と key 索引を worker が消す。bot が channel から外れたときは
  取り込みを止め、保存済みの発言は保持期間まで残す。
- 対応づけたとき（bot が後から招待されたときも）、保持期間内の過去の発言を 1 channel につき最大 2,000 件まで、
  thread の返信は 1 thread 200 件まで読み込む。1 job で 1 ページ（200 件）だけ読み、次のページは job を入れ直す。
- 対応づけの変更と保持日数の変更は監査ログに残す。

### Work Item との紐付け

- 本文から `MK-123` の形（大文字の prefix。`parseWorkItemKey` と同じ形）を最大 20 個拾い、key 索引に書く。
  保存時には Work Item を引かず、読むときに Work Item の現在の key で索引を引く。
- `GET /api/teams/:teamId/issues/:issueId/slack-messages` は Work Item の viewer が呼べ、索引から最大 200 件を読み、
  呼び出した人が対応先を読める channel の発言だけを新しい順に 50 件返す。

### 保持期間

- Workspace 設定の保持日数（7〜730 日、既定 90 日）。各発言の `expiresAt` は発言時刻 + 保持日数で、DynamoDB TTL が消す。
- 保持日数を短くしたときは、読むときに新しい保持期間より古い発言を返さず、worker が対応中の channel の古い発言を消す。
  長くしても、すでに消えた発言は戻らない。
- Slack 側の保持期間で消えた発言には event が来ないので、Mukuroji の保持日数を Slack の保持期間以下にする運用とする。

## 検討した選択肢

- **全 channel を定期的に `conversations.list` と `conversations.history` で読む。** 招待が要らない。ただし
  呼ばれない channel の分まで rate limit と Lambda の時間を使い、private channel を取り込む判断が
  誰の手にも残らない。bot を招待した channel だけに限った。
- **external-chat の link・binding を channel 取り込みにも使う。** 双方向同期用の revision・fence・retry が
  読み取り専用の写しには重すぎる。別の row にし、Slack の ID（team・channel・`ts`）は external-chat と同じ
  canonical ID を使うので、将来 thread を Work Item に link するときに対応づけられる。
- **OpenSearch Serverless などの検索索引に入れる。** 常時課金があり「なるべく安く」に反する。
  検索と回答は #829 で Workspace 検索の拡張から始める。
- **専用の DynamoDB table を作る。** export・削除・復元訓練の対象に別途足す必要がある。
  Workspace の partition を持つ既存の DeveloperPlatformTable に prefix を分けて置いた。

## 結果

- Shinji が Slack app を作り secret を登録するまで、何も動かない。手順は `docs/guide/admin.md` に書く。
- 管理者が対応づけた channel の発言が Mukuroji に入り、Work Item の画面で key を書いた Slack の発言が見られる。
- 費用は SQS・Lambda・DynamoDB の従量分と secret 1 つ（月 $0.40）。
- Slack の Enterprise Grid の複数 workspace、DM、ファイル本体の取り込み、検索・AI 回答（#829）は後続とする。
