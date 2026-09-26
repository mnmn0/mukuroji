# Notifications and Inbox

Mukuroji の Inbox は、Work Item の現在状態から都度組み立てる attention queue ではなく、ユーザー別に永続化した notification timeline を正本とします。

現在も継続する blocker、review、期限、approval などは [Focus queue](./focus.md) が canonical source を再評価して表示します。通知の read/archive/snooze は Focus signal を解消せず、両画面は共通の `eventId` と Work Item scope で相互リンクします。Focus から archived / snoozed event を開く場合は該当 state filter も URL に束縛し、Web は Focus source の bounded windowを覆う範囲でcursor pageを自動取得してexact rowへscroll/focusします。

## Event から notification まで

状態変更と同じ DynamoDB transaction に保存された `AuditEventsTable` の event を、`CollaborationProjectionFunction` が stream から処理します。recipient ごとの notification と processed receipt は同じ transaction に保存し、同じ event が再配送されても notification は一度だけ作成されます。

現在の producer は次の理由を metadata の `notificationCandidates` として渡します。

- Work Item 作成・担当変更: `assignment`
- Work Item status 変更: `status-change`
- Work Item schedule 変更: `schedule-change`
- 定期 due scan: `due` / `overdue`
- comment / reply: `mention` / `reply` / `watcher` / `project-watcher`
- Triage assignment / SLA / escalation: `triage-assignment` / `triage-sla` / `triage-escalation`

Approval と automation の各 subsystem は、実装時に同じ契約で `approval` / `automation-failure` candidate と deep link を発行します。notification projector は event type を限定せず、候補を持つ audit event を同じ重複排除・認可ルールで扱います。

## 保存モデル

`NotificationsTable` は次の key を使います。

```text
recipientKey          = <workspaceId>#<normalizedMemberKey>
notificationKey       = <occurredAt>#<eventId>
recipientStatusKey    = <recipientKey>#<unread|read|archived|snoozed>
```

`RecipientStatusIndex` は `recipientStatusKey` と `notificationKey` で status ごとの timeline と実 unread 件数を query します。opaque notification ID と cursor は recipient、filter、last evaluated key に束縛し、別ユーザーや別 filter へ流用できません。

Notification row は `recipientStatusKey`、`itemType: notification`、正の `version` を必須とする current schema で保存します。current schema でない row は request path で補完せず、`InvalidNotificationData`（503）の fail-closed エラーとして扱います。

read、archive、snooze は notification row に version 付きで保存します。snooze 期限を過ぎた row は次の Inbox/count read で read/unread state に戻ります。この解除処理は250件 × 4 page（最大1,000行）で正常に打ち切り、残りは次回の read へ持ち越します。cursor が進まない場合だけ `503` で fail closed します。`mark-all-read` は active unread row のみを更新し、archive や有効な snooze は解除しません。

## API

```http
GET  /api/notifications?filter=all|unread|read|archived|snoozed&type=...&limit=...&cursor=...
GET  /api/notifications/unread-count
PATCH /api/notifications/{notificationId}
POST /api/notifications/mark-all-read
GET  /api/notification-preferences
PUT  /api/notification-preferences
```

PATCH action は `mark-read`、`mark-unread`、`archive`、`restore`、`snooze` です。`snooze` は future ISO 8601 timestamp を要求します。

API は認証済み member の partition 以外を読みません。さらに、現在の active Team、assigned Project、project member role を強整合 read で再確認し、notification 作成後に権限を失った対象を list、unread count、mutation のすべてで非表示にします。Work Item の Project が変わった場合は response の構造化 target も現在値へ更新するため、deep link は古い Project を開きません。system admin も現在の認証結果だけを使用します。

## Deep link

Work Item は実在する router contract に合わせて次の形式で開きます。

```text
/teams/<teamId>/issues?issueId=<issueId>
```

Triage notification は `teamId` と `triageEntryId` の構造化 target から次を生成します。

```text
/teams/<teamId>/triage?entryId=<triageEntryId>
```

Web は構造化 target を保存済み `deepLink` より優先し、Team/Entry に束縛したルートを
生成します。Triage から受け入れた Work Item と source へ移動し、Work Item 側の
`sourceTriageEntryId` から元の受入判断へ戻れます。

Comment notification は `commentId` と `rootCommentId` を追加します。Web は必要な reply page を取得した後、対象 comment を scroll/focus します。API は保存済みの内部相対 path だけを返し、外部 URL は deep link として扱いません。

## Preferences

ユーザーごとに次を保存します。

- channel: in-app、email、push、Slack（既定は無効）
- frequency: instant、hourly、daily、weekly
- quiet hours: enabled、start、end、IANA time zone

in-app を無効にした状態で投影された notification は Inbox unread に入りません。email/push は delivery plan と配信予定時刻を notification に記録し、対応 channel の transport が有効な環境で同じ予定を使用できます。push transport と subscription は installable PWA の実装範囲で接続します。

## Slack 配信

通知設定の **Slack** を有効にして保存すると、その後に作成される担当・メンション・返信・期限などの既存通知を、同じ受信者のSlack送信先にも配信します。`channels.slack` を省略した既存API clientと保存済み設定は無効として扱います。Inboxを無効にしてもSlackだけの配信は可能です。既存の通知をさかのぼって送ることはありません。

管理者は受信者ごとに [Slack Incoming Webhook](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/) を作成し、そのURLを次のSecrets Manager IDに**プレーンな文字列**で登録します。

```text
mukuroji/automation-webhooks/<sha256(workspaceId.trim())>/slack/<sha256(memberKey.trim().toLowerCase())>
```

既存のAutomation secret namespace内の専用サブディレクトリを使用するため、既存のsecret aliasとは衝突せず、Workspaceの閉鎖時には既存のsecret削除・検証処理の対象になります。送信先は受信者の個人用Slackチャンネルなど、当該通知を開示してよいメンバーだけが参加する場所を選んでください。Webhookは作成時に選んだチャンネルに固定されます。アプリのユーザーが別の受信者の送信先を指定するAPIはありません。URLはソース、環境変数、通知row、API response、ログには保存しません。通常SlackとGovSlackの公式Incoming Webhook URLだけを許可します。

CDKで追加される `SlackDeliveryIndex` と `SlackNotificationFunction` のデプロイ後に有効化します。既存テーブルの置換や通知データのbackfillは不要です。ローカルでは `floci:up` がindexを追加し、`workers:dev` が同じworkerを毎分実行します。Secrets Managerの接続には既存の `SECRETS_MANAGER_ENDPOINT` 設定を使用します。

通知と同一transaction内に保存される配信予定を16 shardのsparse GSIから検索し、毎分最大32件を処理します。`instant` は通常次の実行時に届き、他の頻度は既存のdelivery planが定める遅延後に、通知ごとに送信します（複数通知を1メッセージにまとめるdigestではありません）。現在のquiet hoursとsnoozeは送信直前にも確認します。Slackの無効化、Workspace閉鎖、メンバー削除、閲覧権限の喪失、期限通知の対象変更、retention期限切れは配信を抑止します。

60秒のleaseとversion条件で並行workerを排他し、成功した通知はdue indexから除外します。Slackの429と一時障害は最大5試行、指数backoffと `Retry-After`（最大24時間）の長い方で再試行します。本文は最大3,000文字のプレーンテキストで、Slackのメンション展開やリンクプレビューは無効です。Webhookの応答喪失や成功直後の永続化障害では重複投稿の可能性があります。Incoming Webhook自体にはexactly-once保証がないためです。

永続的失敗はnotification rowの `slackDeliveryStatus: failed` と秘密情報を含まない `slackLastCode` に残り、Lambda errorsおよび `SlackNotificationDlq` のアラーム対象になります。失敗rowは同じ `SlackDeliveryIndex` の `slack-failed#<番号>` partitionへ移し、ランダムな `slackFailureReference` を記録します。CloudWatchの `SlackNotificationFailed` ログにある `shard` と `dueAt` でindexをQueryし、返されたkeyをGetして `slackFailureReference` とログの `reference` を照合すれば、テーブル全体をScanせず対象を特定できます。ログは90日保持し、通知本文、メールアドレス、Webhook URLを含めません。

送信先を修復した後、運用者は該当rowのversionを条件に `slackAttempts: 0`、`slackDeliveryStatus: pending`、元の `slackQueueShard`（`slack#<番号>`）、現在時刻の `slackNextAttemptAt` を戻して再試行できます。送信済みrowの再投入は重複投稿になるため、Slack側の着信を先に確認します。`notification-schedule` runtime controlで停止できます。`Mukuroji/Notifications` の `OldestDueAgeSeconds`（`Channel: Slack`）が15分以上の状態で3回続くと滞留アラームを出します。破損候補は最大10ページまで越えて後続を処理し、`InvalidQueueCandidates` とworker失敗で検出します。破損した正本は自動で書き換えず、運用者が確認・修復します。

送信前にInboxのversionが変わった場合は、そのclaimを解放して試行回数を戻します。Directory・enterpriseの認可snapshotは同じworker呼び出し内で5秒間だけ共有します。Cognitoグループとsystem admin判定は配信ごとに再取得・評価し、Work Itemやメンバーの現在状態も通知ごとに再取得します。1 shardあたり毎分2件のため、滞留アラームが続く場合はdue indexの最古時刻と件数、破損候補、送信先の制限を調査してください。

Document由来の通知は、送信のたびにInboxと同じDocuments取得機能で現在のprivate ACL、親Documentの継承ACL、archive状態を確認します。Enterprise RBACは `documents.read/write/manage` の権限を評価し、Work Item権限や過去のProject roleでは代用しません。参照不可・削除済みのDocumentは送信せず、取得の一時障害は再試行します。

承認通知は承認IDとファイルIDを保持し、送信ごとに現在の承認・ファイルを強整合readします。削除済みファイル、guest公開を取り消したファイルは送信せず、Enterpriseでは `files.read` と外部メンバーのpermission ceilingを評価します。旧通知にファイルIDがない場合も、現在の承認rowからファイル対象を解決します。承認の対象が確認できない通知は送信しません。

保存済み通知設定が破損している場合は、Slack無効化として通知を破棄せず、最大5試行の再試行・失敗監視へ進めます。未保存の設定は従来どおりSlack無効です。1件のclaimが一時的に失敗しても同じbatchと後続shardの処理を続け、queue healthを記録したうえでworker失敗を通知します。

Triage通知も現在のEntryを取得し、送信時点のProjectと担当者を照合します。`metadata-only` / `denied` またはredactedなsourceは、保存済みの本文を外部に出さないためSlack配信を抑止します。Work Item / TriageのEnterprise権限も現在の `work-items.read` で評価し、Project未所属のTeam通知にはTeam全体の閲覧権限を要求します。

Workspace直下のPlanning通知もWorkspaceリソースで認可します。担当者向けreminder/overdueには更新権限、ウォッチャーには現在の購読と閲覧権限を要求します。Cognitoグループは全ページを取得して再評価し、SCIM無効化・guest許可・外部ドメイン制限・permission ceilingも適用します。

Work Itemの担当者だけに向けた通知は、担当変更・状態変更・日程変更も含め、現在の担当者との一致をInboxと共通の条件で確認します。Cognitoから削除済みの受信者は再試行せず配信を抑止し、一時的なCognito障害のみ再試行します。通知設定は認可処理の後にも読み直し、その間のSlack無効化・quiet hours変更を反映します。

## Due / overdue scan

EventBridge の定期 rule が canonical Work Item を bounded pagination で走査します。date-only の期限は各 item の `schedule.calendarPolicy.timeZone` における local calendar day として評価し、未完了かつ担当者がある item に対し、期限当日は `work-item.due`、期限超過後は `work-item.overdue` を作ります。event ID は Workspace、Work Item、due date、reason から決定的に作るため、Lambda retry や翌日の再走査でも同じ due 状態を重複通知しません。

期限境界の authoritative time zone は各 Work Item の canonical schedule が所有します。Notification scan と Web の due/overdue 表示は同じ `schedule.calendarPolicy.timeZone` を使用し、実行環境や viewer の local timezone から期限状態を推測しません。
