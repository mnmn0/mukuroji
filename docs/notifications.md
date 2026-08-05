# Notifications and Inbox

Mukuroji の Inbox は、Work Item の現在状態から都度組み立てる attention queue ではなく、ユーザー別に永続化した notification timeline を正本とします。

## Event から notification まで

状態変更と同じ DynamoDB transaction に保存された `AuditEventsTable` の event を、`CollaborationProjectionFunction` が stream から処理します。recipient ごとの notification と processed receipt は同じ transaction に保存し、同じ event が再配送されても notification は一度だけ作成されます。

現在の producer は次の理由を metadata の `notificationCandidates` として渡します。

- Work Item 作成・担当変更: `assignment`
- Work Item status 変更: `status-change`
- Work Item schedule 変更: `schedule-change`
- 定期 due scan: `due` / `overdue`
- comment / reply: `mention` / `reply` / `watcher` / `project-watcher`

Approval と automation の各 subsystem は、実装時に同じ契約で `approval` / `automation-failure` candidate と deep link を発行します。notification projector は event type を限定せず、候補を持つ audit event を同じ重複排除・認可ルールで扱います。

## 保存モデル

`NotificationsTable` は次の key を使います。

```text
recipientKey          = <workspaceId>#<normalizedMemberKey>
notificationKey       = <occurredAt>#<eventId>
recipientStatusKey    = <recipientKey>#<unread|read|archived|snoozed>
```

`RecipientStatusIndex` は `recipientStatusKey` と `notificationKey` で status ごとの timeline と実 unread 件数を query します。opaque notification ID と cursor は recipient、filter、last evaluated key に束縛し、別ユーザーや別 filter へ流用できません。

`RecipientStatusIndex` 導入前の notification row は、recipient の初回 read 時に base partition を bounded pagination で強整合走査し、state key と version を条件付きで補完します。完了 marker も同じ partition に保存するため、以後の request は一度きりの移行を繰り返しません。

read、archive、snooze は notification row に version 付きで保存します。snooze 期限を過ぎた row は次の Inbox/count read で read/unread state に戻ります。`mark-all-read` は active unread row のみを更新し、archive や有効な snooze は解除しません。

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

Comment notification は `commentId` と `rootCommentId` を追加します。Web は必要な reply page を取得した後、対象 comment を scroll/focus します。API は保存済みの内部相対 path だけを返し、外部 URL は deep link として扱いません。

## Preferences

ユーザーごとに次を保存します。

- channel: in-app、email、push
- frequency: instant、hourly、daily、weekly
- quiet hours: enabled、start、end、IANA time zone

in-app を無効にした状態で投影された notification は Inbox unread に入りません。email/push は delivery plan と配信予定時刻を notification に記録し、対応 channel の transport が有効な環境で同じ予定を使用できます。push transport と subscription は installable PWA の実装範囲で接続します。

## Due / overdue scan

EventBridge の定期 rule が canonical Work Item を bounded pagination で走査します。date-only の期限は UTC calendar day として評価し、未完了かつ担当者がある item に対し、期限当日は `work-item.due`、期限超過後は `work-item.overdue` を作ります。event ID は Workspace、Work Item、due date、reason から決定的に作るため、Lambda retry や翌日の再走査でも同じ due 状態を重複通知しません。

Workspace 単位の authoritative time zone は現行 schema に存在しません。将来これを導入する場合は、schedule だけを固定 time zone に変えず、Work Item の期限定義と Web の due/overdue 表示も同じ境界へ同時に移行します。
