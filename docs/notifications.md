# Notifications and Inbox

Mukuroji の Inbox は、Work Item の現在状態から都度組み立てる attention queue ではなく、ユーザー別に永続化した notification timeline を正本とします。

現在も継続する blocker、review、期限、approval などは [Focus queue](./focus.md) が canonical source を再評価して表示します。通知の read/archive/snooze は Focus signal を解消せず、両画面は共通の `eventId` と Work Item scope で相互リンクします。Focus から archived / snoozed event を開く場合は該当 state filter も URL に束縛し、Web は Focus source の bounded windowを覆う範囲でcursor pageを自動取得してexact rowへscroll/focusします。

## Event から notification まで

状態変更と同じ DynamoDB transaction に保存された `AuditEventsTable` の event を、`CollaborationProjectionFunction` が stream から処理します。recipient ごとの notification と processed receipt は同じ transaction に保存し、同じ event が再配送されても notification は一度だけ作成されます。

現在の producer は次の理由を metadata の `notificationCandidates` として渡します。

- Work Item 作成・担当変更: `assignment`
- Work Item status 変更: `status-change`
- Work Item schedule 変更: `schedule-change`
- Work Item archive / restore: `archive-change`
- 上記の変更の作成者: `creator`（責任者と同じ人なら 1 件にまとまる）
- 上記の変更の item watcher: `watcher`（projection が現在の購読から解決する。Project watcher には送らない。title や説明だけの変更では送らない）
- blocker の解除（`work-item.blocker-removed`、block されていた側の event）: 責任者に `assignee`、item watcher に `watcher`。責任者がいない Work Item でも watcher には送る。blocker を追加したときと、block していた側の `work-item.blocking-removed` では送らない。relation を消した本人には送らない。Work Item の削除で relation が消えた場合と、blocker が完了しただけの場合は対象外（relation 自体は残る）
- 定期 due scan: `due` / `due-soon` / `overdue` / `escalation` / `stale`
- 定期 timesheet scan: `timesheet`（未提出の工数の督促）
- comment / reply: `mention` / `reply` / `watcher` / `project-watcher`
- Planning update の publish / health 悪化 / コメント: `watcher` / `project-member` / `escalation` / `update-owner` / `update-author` / `mention`（詳細は [Planning](./planning.md)）
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

### 概要の文言

システムが書く概要は、文ではなく code と値（`message: { code, params }`）でも保存します。code ごとの日本語と英語の文言は `contracts/src/notification-messages.ts` の `NOTIFICATION_MESSAGE_TEMPLATES` にあり、`{name}` を同じ名前の値で置き換えます（値の中の `{name}` は置き換えません）。producer は audit metadata の `notificationMessage` に code と値を入れ、`summary` には同じ code の英語の文を入れます。projection は読めた code だけを通知 row の `message` に写します。

Web の Inbox は表示言語で、Slack と Email は受信者の表示設定の言語（未設定は日本語）で文にします。`message` のない row、知らない code、壊れた値は保存済みの `summary` をそのまま出すため、code を入れる前の通知と古い client も読めます。ブロック解除と定期配信のレポートは、以前から Web が event type で翻訳しているので、その文言を優先します。人が書いた文（コメントの本文や Health update の抜粋など）は値として入れるだけで翻訳しません。

read、archive、snooze は notification row に version 付きで保存します。snooze 期限を過ぎた row は次の Inbox/count read で read/unread state に戻ります。この解除処理は250件 × 4 page（最大1,000行）で正常に打ち切り、残りは次回の read へ持ち越します。cursor が進まない場合だけ `503` で fail closed します。`mark-all-read` は active unread row のみを更新し、archive や有効な snooze は解除しません。

## API

```http
GET  /api/notifications?filter=all|unread|read|archived|snoozed&type=...&limit=...&cursor=...
GET  /api/notifications/unread-count
PATCH /api/notifications/{notificationId}
POST /api/notifications/mark-all-read
POST /api/notifications/bulk
GET  /api/notification-preferences
PUT  /api/notification-preferences
GET  /api/teams/{teamId}/notification-reminders
PUT  /api/teams/{teamId}/notification-reminders
GET  /api/push/config
PUT  /api/push-subscriptions
DELETE /api/push-subscriptions
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
- reminder days（`reminderDays`）: 自分あての期限前通知・超過の再通知・未更新の督促・工数の督促の日数（下の [リマインドの日数](#リマインドの日数)）。PUT で `reminderDays` を省略すると保存済みの値を残し、空 object を送ると消します。項目を知らない古い client が保存しても消えないようにするためです

- category channels（`categoryChannels`）: 通知の種類ごとに切ったチャネル（下の [種類ごとの配信先とミュート](#種類ごとの配信先とミュート)）。保存するのは `false` だけです
- mutes（`mutes`）: ミュートした Project（`projectKeys`、Project ID は Team の中でだけ一意なので `<teamId>#<projectId>` で持つ）・Team（`teamIds`）を各 100 件までと、ミュート中も届ける mention・承認の切り替え（既定はどちらも届ける）

`categoryChannels` と `mutes` も `reminderDays` と同じく、PUT で省略すると読み込んだ version の保存値を残します。保存済みの値が壊れている row は、既定値で読み替えずにエラーにします。`categoryChannels` か `mutes` を持つ row は、ほかの項目が壊れている場合も同じです（読み替えると、ミュートした通知が届いてしまうため）。

in-app を無効にした状態で投影された notification は Inbox unread に入りません。email/push は delivery plan と配信予定時刻を notification に記録します。Email は送信元を設定した環境で [Email 配信](#email-配信) がこの予定を使います。push transport（VAPID 署名と payload 暗号化による配信 worker）は後続で接続します。

### 種類ごとの配信先とミュート

通知は受信者ごとに 1 つの種類（category）に入ります。分類は `server/src/modules/notifications/domain/notification-routing.ts` の `classifyNotificationCategory` が持ち、受信者の reasons を `mention`、`approval`、`assignment`、`due`、`status`、`comment`、`reminder` の順に見て、どれにも当たらなければ event type で決めます（`approval.*` は reasons より先に承認とします）。種類は `mention`・`approval`・`assignment`・`status`・`due`・`comment`・`planning`・`reminder`・`other` です。

あるチャネルに届くのは、チャネル全体の switch が on、その種類でチャネルが切られていない、ミュートされていない、のすべてを満たすときです。ミュートは notification の `teamId` と `projectId` の組が `projectKeys` に、または `teamId` が `teamIds` に含まれるときで、種類が mention か approval で対応する切り替えが on なら除きます。

- 投影（`createNotificationProjectionDeliveryState`）: 種類やミュートで in-app に届かない通知は archived row として保存し、unread には入れません（アーカイブの一覧には出ます）。全体の in-app switch が off のときは従来どおり `inAppVisible: false` で一覧にも出しません。届かない channel は `deliveryChannels` と Slack / Email の queue に入れません
- 外部 channel の送信（`deliverDueChannelNotifications`）: 送る直前に強整合で読んだ preference で同じ判定をやり直し、投影後に種類を切ったりミュートしたりした通知は `suppressed` にします
- 更新ダイジェスト（`update-feed.digest`、種類は other）: Inbox に書く時点で同じ判定を使い、in-app に届かなければ archived row にします
- 判定は受信者本人の設定で配信を減らすだけで、受信者の選び方と閲覧権限の確認は変えません

### Inbox の一括操作

```http
POST /api/notifications/bulk
{ "action": "mark-read" | "mark-unread" | "archive" | "restore", "notificationIds": ["..."] }
```

1 回に 50 件まで受け付け、同じ ID は 1 回だけ処理します。各通知は `PATCH /api/notifications/{notificationId}` と同じ所有者・現在権限・version の確認を通り、4 件ずつ並行して更新します。更新できなかった通知は request 全体を失敗にせず、`failures` に `{ id, status, code }` で返します。処理は `application/bulk-notification-update.ts` が持ち、route は入力の検証と response の変換だけを行います。response は `{ notifications, failures, unreadCount }` です。storage の障害など NotificationError でない失敗は request 全体を失敗にします。Web は選択を 50 件ずつに分けて送り、失敗した通知を選択に残します。

## Web Push の購読

設定画面の **このデバイスのプッシュ通知** で、ブラウザまたはインストールしたアプリを購読として登録します。
配信チャネルの **プッシュ** は member 単位の受信設定、購読はデバイス単位の宛先です。

- `GET /api/push/config` は `{ enabled, vapidPublicKey? }` を返します。runtime 設定 `WEB_PUSH_VAPID_PUBLIC_KEY`
  （CloudFormation parameter `WebPushVapidPublicKey`）が空または不正な場合は `enabled: false` で、登録は `409 PushNotificationsDisabled` です。
  Floci では `.env` などで `WEB_PUSH_VAPID_PUBLIC_KEY` を設定すると `bun run floci:deploy-backend` が Lambda に渡します（`PUSH_SUBSCRIPTIONS_TABLE_NAME` の既定は `mukuroji-push-subscriptions-local`）。
- `PUT /api/push-subscriptions` は `{ endpoint, keys: { p256dh, auth } }` だけを受け付けます。client は `PushSubscription.toJSON()` からこの 3 つを取り出して送り、`expirationTime` など他の field を含む body は `400` です。
  member や Workspace は request に含めず、認証済み member に保存します。service account など人以外は `403` です。
- endpoint は HTTPS かつ既知の push service（FCM、Mozilla、Apple、Windows）の host だけを許可し、認証情報・port・fragment（`#`。push service へ送られないため、同じ endpoint が別の ID を得てしまいます）・正規化で変わる URL を拒否します。
  配信 worker が任意の宛先へ request を送らないための境界です。`p256dh` は 65 byte の非圧縮 P-256 公開鍵で、曲線上の点であることも確認します（後の暗号化で必ず失敗する鍵を保存しません）。`auth` は 16 byte で、どちらも padding なし base64url です。
- 保存先は `PushSubscriptionsTable` です。member の購読（`member#<workspaceId>#<memberKey>` / `subscription#<id>`。各 ID は URL エンコードし、`#` を含む ID でも区切りがずれません）と endpoint の所有者
  （`endpoint#<id>` / `owner`）を 1 transaction で書き、同じ endpoint を別 member が登録すると前の member の購読を削除します。
  共有端末で別の人の通知が届き続けることはありません。所有者の行には最後の登録・削除の server 時刻（`changedAt`）と書き込みごとの乱数の revision を記録し、所有者の行への書き込みはすべて読んだ revision を条件にするため、変更は必ず順番に適用されます。request の開始以降（同じミリ秒を含む）に（どの member でも）登録・削除があった場合、その登録は古い request として `409 PushSubscriptionConflict` にし、端末を取り戻したり購読を作り直したりしません。ただし、後から登録したのが同じ member で購読が有効なままなら、すでに目的の状態なので書き込まずに成功を返します。所有者の読み取りと transaction の間に競合した場合は 3 回まで再試行し、それでも競合すれば `409 PushSubscriptionConflict` です。
  再試行するのは transaction の取消理由が条件不一致または transaction 競合だけの場合で、throttling などの基盤エラーはそのまま再試行可能な失敗として返します。
- 1 member あたり 20 デバイスまでで、超えると `409 PushSubscriptionLimitExceeded` です。保持期限（`expiresAt`）を過ぎた購読は、DynamoDB の TTL が実際に削除する前でも数えず（`expiresAt` がない・数値でない壊れた行は数えます）、再登録では新しいデバイスとして上限を確認します。member ごとの登録 version の行が version を持たない壊れた状態なら上書きせず `503 PushSubscriptionUnavailable` にします。新しいデバイスの登録は member ごとの登録 version
  （`member#<workspaceId>#<memberKey>` / `devices`）を件数の読み取りと同じ transaction で更新するため、同時に登録しても上限を超えません。
  購読は 180 日で TTL 失効し、所有者の行はその 30 日後に失効します。DynamoDB は期限切れの行を個別に遅れて削除するため、
  所有者が先に消えて別の member が前の登録を残したまま同じ endpoint を登録することを防ぎます。配信 worker は送信前に所有者の行が
  tombstone でなくその member を指していることを確認してから送信します（後続の配信 worker の要件）。購読済みのデバイスでは Workspace を開くたび（と設定画面の表示時）に登録し直して期限と所有者を更新します。
- tenant の export・削除・検証の対象に含めます（member 行・所有者行（tombstone を含む）・登録 version はすべて `workspaceId` を持ちます）。
  Workspace ID の filter 付き scan のため、export・削除・検証の各 job は最大 1,000 行を評価します（scan の limit は filter の前に適用されるため、少ない行数ずつでは共有 table の行数に比例して job が続きます）。削除は 25 件ずつ行い、別 Workspace に引き継がれて残した行は削除件数（完了の evidence）に数えません。
  所有者行の key は endpoint だけで決まり、scan の後に別 Workspace が同じ endpoint を引き継ぐことがあるため、削除はまだ閉鎖する Workspace の行である場合だけ条件付きで行い、引き継がれた行は残します。
- `DELETE /api/push-subscriptions` は `{ endpoint }` の購読を削除し、まだ自分が所有している場合は所有者の行を削除時刻付きの tombstone（`removed: true`）に置き換えます。
  別の tab や再試行で削除より前に始まった登録は tombstone より古いため、削除の後に購読を作り直せません。
  端末は最後に登録した endpoint を覚えておき、サインアウト時に browser の push store を読めない場合もその endpoint で server から削除します。停止では server の削除を待たずに browser の購読を解除し、解除できなかった場合（`unsubscribe()` が `false`）は失敗として表示し、覚えた endpoint を残します。request の開始より後に変更があった削除は古い request として、その新しい状態を変えません。
  明示的なサインアウトはすべて同じ処理（`signOutWithPushCleanup`）を通り、表示中の app の通知を閉じ（別の account が確定した購読の通知は残します）、browser の購読をすぐに解除し、
  破棄前の token でこの削除をすぐに送り（完了しない登録があっても削除が始まるようにするため）、送信中の登録（Workspace を開いた時の再登録や有効化）があった場合はその完了後に、最初の削除の完了を待たずにもう一度送ります（削除の後に server へ届いた古い登録が購読を残さないため）。
  browser の購読は origin で 1 つを全 tab が共有するため、端末は最後に登録した account（access token の `sub`）も覚えておき、別の tab で別の account が後から登録していた場合は自分の登録だけを server から削除し、browser の購読と記憶はその account に残します。登録する tab は request を送る前に記憶を自分の account の「確認待ち」に書き換え、server が受け付けてから確定します（失敗した場合は前の記憶に戻します）。確定と巻き戻しは request ごとの乱数の claim が記憶に残っている場合だけ行い、後から別の tab が書いた記憶を上書きしません。Web Locks がある browser では有効化（古い購読の作り直しを含む）と再登録は応答まで tab 間の lock を持ち、別の tab のサインアウトと停止は最大 1.5 秒その確定を待ってから判断します。待っても確定しない（offline などで応答がない）確認待ちの記憶は所有の根拠にしないため、購読は解除されます（前の member の通知が残らないことを優先します）。サインアウトで購読を解除できなかった場合は、endpoint の記憶を残します。別の account が確定した購読は、この account では「未登録」と表示し、Workspace を開いた時の再登録もせず、停止でも自分の登録だけを server から削除します。別の account の購読を自分に登録し直そうとして拒否された場合も、その購読は解除しません。停止の削除は、送信中だった自分の再登録が完了した後にもう一度送ります。サインアウト時は覚えた endpoint の削除を browser の push store を読む前に始め（service worker の待ちでサインアウトの待ち時間を使い切らないため）、push の API が使えなくなっていても削除します。停止の時点で browser の購読が消えていた場合も、自分が登録した endpoint を server から削除します。登録の失敗後に購読を解除できなかった場合は endpoint の記憶を残します。
  その完了（最大 3 秒）を待ってから session を消して画面を移動します。tab を閉じる前に購読が残ることを防ぎつつ、遅い network でサインアウトを止めません。
  期限切れによるサインアウトでは解除しません。
- 有効化では、通知の許可を click の中で尋ねてから購読します。以前の VAPID key で作られた購読や、browser が鍵を返さない購読は、
  解除して作り直し、新しい endpoint が古いものと異なる場合は登録の前に古い行の削除を最大 3 秒待ちます（古い行がデバイス数の上限に数えられないため。止まった削除で作り直しを止めないよう待ち時間は限ります）。同じ endpoint が返った場合は登録がその行を置き換えるため削除しません（遅れて届いた削除が新しい登録を消さないため）。server が登録を拒否した場合はその場で作った購読を解除し、既存の購読を再利用した場合も server が保持できないと答えた（上限超過や競合など）なら解除して「未登録」と表示します。network の失敗では既存の購読を残します。
  push の request が期限切れや session policy 違反で失敗した場合は、通知設定と同じく Workspace の session 境界に渡して再認証へ移ります。設定の取得結果がどちらの形にも当てはまらない場合や VAPID 公開鍵が padding なし base64url の 65 byte 非圧縮 P-256 形式でない場合は「無効」とせず、再読み込みできる読み込み失敗にします。通知がブロックされている場合は、端末の設定で許可した後に状態を再確認できるボタンを表示します。有効化・停止に失敗した場合は、確認済みの状態を表示したままにします。push の購読状態や service worker を読めない場合は「未登録」や「非対応」とせず、再読み込みできる読み込み失敗として表示します。初回訪問では service worker の登録を
  最大 10 秒待ち、それでも登録がない場合は「非対応」とせず再読み込みできる読み込み失敗にします。VAPID 公開鍵は P-256 曲線上の点であることも確認し、誤った鍵では push を無効のままにします。停止では server の削除が失敗しても browser の購読を解除し、
  失効した endpoint は配信 worker が push service の応答から削除します。

Service worker は `push` を受けると payload（`PushNotificationPayload`: `title`、`body`、`path`、`tag`）を通知として表示します。
payload がない・壊れている場合も browser の要件どおり汎用の通知を表示します。`path` は app の deep link と同じ同一 origin path 判定を通ったものだけを使い、
それ以外はインボックスを開きます。通知の click では、focus 中の app window を優先して再利用し、遷移できない場合（`navigate` が失敗または `null` を返した場合）は新しい window を開きます。

## Slack 配信

通知設定の **Slack** を有効にして保存すると、その後に発生する担当・メンション・返信・期限などの既存通知を、同じ受信者のSlack送信先にも配信します。`channels.slack` を省略した既存API clientと保存済み設定は無効として扱います。Inboxを無効にしてもSlackだけの配信は可能です。有効化時刻をサーバーで保存し、auditの投影が遅れても、それより古いイベントはSlackへ送りません。設定の頻度変更ではこの時刻を保持し、無効化後の再有効化では更新します。送信直前も現在の有効化時刻を確認するため、以前の配信待ち通知が再有効化で復活することはありません。有効化時刻も旧設定の保存時刻も不明な場合は配信せず、設定の再保存で時刻を確定します。

送信直前の最終確認を通過した通知は、その直後にSlackを無効化・再有効化しても届く場合があります。Slackへの外部送信と設定保存は同一transactionにできないため、すでに送信処理に入った通知の取り消しは保証しません。

管理者は受信者ごとに [Slack Incoming Webhook](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/) を作成し、そのURLを次のSecrets Manager IDに**プレーンな文字列**で登録します。

```text
mukuroji/automation-webhooks/<sha256(workspaceId.trim())>/slack/<sha256(memberKey.trim().toLowerCase())>
```

既存のAutomation secret namespace内の専用サブディレクトリを使用するため、既存のsecret aliasとは衝突せず、Workspaceの閉鎖時には既存のsecret削除・検証処理の対象になります。送信先は受信者の個人用Slackチャンネルなど、当該通知を開示してよいメンバーだけが参加する場所を選んでください。Webhookは作成時に選んだチャンネルに固定されます。アプリのユーザーが別の受信者の送信先を指定するAPIはありません。URLはソース、環境変数、通知row、API response、ログには保存しません。通常SlackとGovSlackの公式Incoming Webhook URLだけを許可します。

CDKで追加される `SlackDeliveryIndex` と、Slack job を毎分実行する `ScheduledJobsFunction` のデプロイ後に有効化します。既存テーブルの置換や通知データのbackfillは不要です。ローカルでは `floci:up` がindexを追加し、`workers:dev` が同じworkerを毎分実行します。Secrets Managerの接続には既存の `SECRETS_MANAGER_ENDPOINT` 設定を使用します。

通知と同一transaction内に保存される配信予定を16 shardのsparse GSIから検索し、毎分最大32件を処理します。`instant` は通常次の実行時に届き、他の頻度は既存のdelivery planが定める遅延後に、通知ごとに送信します（複数通知を1メッセージにまとめるdigestではありません）。現在のquiet hoursとsnoozeは送信直前にも確認します。Slackの無効化、Workspace閉鎖、メンバー削除、閲覧権限の喪失、期限通知の対象変更、retention期限切れは配信を抑止します。

通知を投影する際にも保存済み設定を検証します。設定が破損している場合は通知と処理済みreceiptを確定せず、そのstream recordを失敗として返します。他のrecordは処理を続け、設定の修復後にstreamの再試行または失敗イベントの再処理で配信予定を作成できます。設定が未保存の受信者には従来のdefaultを使用します。

60秒のleaseとversion条件で並行workerを排他し、成功した通知はdue indexから除外します。Slackの429と一時障害は最大5試行、指数backoffと `Retry-After`（最大24時間）の長い方で再試行します。本文は最大3,000文字のプレーンテキストで、Slackのメンション展開やリンクプレビューは無効です。概要は受信者の表示設定の言語で書き（[概要の文言](#概要の文言)）、言語を読めないときは送らずに再試行します。Webhookの応答喪失や成功直後の永続化障害では重複投稿の可能性があります。Incoming Webhook自体にはexactly-once保証がないためです。

HTTPエラーの再試行可否と待機時間は、受信済みのstatusと `Retry-After` で判定します。エラー本文は読み取らず破棄し、本文の接続切断や破棄処理の失敗で429の待機時間を失ったり、403などの恒久的な拒否を再試行へ変えたりしません。HTTP 200は引き続き本文の `ok` を確認してから成功扱いにし、その確認前の通信障害は再試行します。

永続的失敗はnotification rowの `slackDeliveryStatus: failed` と秘密情報を含まない `slackLastCode` に残り、`ScheduledJobsDlq` のアラーム対象になります（Slack job は二重送信を避けるため retry しません）。失敗rowは同じ `SlackDeliveryIndex` の `slack-failed#<番号>` partitionへ移し、ランダムな `slackFailureReference` を記録します。CloudWatchの `SlackNotificationFailed` ログにある `shard` と `dueAt` でindexをQueryし、返されたkeyをGetして `slackFailureReference` とログの `reference` を照合すれば、テーブル全体をScanせず対象を特定できます。ログは90日保持し、通知本文、メールアドレス、Webhook URLを含めません。

送信先を修復した後、運用者は該当rowのversionを条件に `slackAttempts: 0`、`slackDeliveryStatus: pending`、元の `slackQueueShard`（`slack#<番号>`）、現在時刻の `slackNextAttemptAt` を戻して再試行できます。送信済みrowの再投入は重複投稿になるため、Slack側の着信を先に確認します。`notification-schedule` runtime controlで停止できます。`Mukuroji/Notifications` の `OldestDueAgeSeconds`（`Channel: Slack`）が15分以上の状態で3回続くと滞留アラームを出します。破損候補は最大10ページまで越えて後続を処理し、`InvalidQueueCandidates` とworker失敗で検出します。破損した正本は自動で書き換えず、運用者が確認・修復します。

送信前にInboxのversionが変わった場合は、そのclaimを解放して試行回数を戻します。Directory・Enterprise・Cognitoグループとsystem admin判定は配信ごとに再取得・評価し、通知間で認可snapshotを共有しません。Work Itemやメンバーの現在状態も通知ごとに再取得します。1 shardあたり毎分2件のため、滞留アラームが続く場合はdue indexの最古時刻と件数、破損候補、送信先の制限を調査してください。

Document由来の通知は、送信のたびにInboxと同じDocuments取得機能で現在のprivate ACL、親Documentの継承ACL、archive状態を確認します。Enterprise RBACは `documents.read/write/manage` の権限を評価し、Work Item権限や過去のProject roleでは代用しません。参照不可・削除済みのDocumentは送信せず、取得の一時障害は再試行します。

承認通知は承認IDとファイルIDを保持し、送信ごとに現在の承認・ファイルを強整合readします。削除済みファイル、guest公開を取り消したファイルは送信せず、Enterpriseでは `files.read` と外部メンバーのpermission ceilingを評価します。旧通知にファイルIDがない場合も、現在の承認rowからファイル対象を解決します。承認の対象が確認できない通知は送信しません。

保存済み通知設定が破損している場合は、Slack無効化として通知を破棄せず、最大5試行の再試行・失敗監視へ進めます。未保存の設定は従来どおりSlack無効です。1件のclaimが一時的に失敗しても同じbatchと後続shardの処理を続け、queue healthを記録したうえでworker失敗を通知します。

Triage通知も現在のEntryを取得し、送信時点のProjectと担当者を照合します。`metadata-only` / `denied` またはredactedなsourceは、保存済みの本文を外部に出さないためSlack配信を抑止します。Work Item / TriageのEnterprise権限も現在の `work-items.read` で評価し、Project未所属のTeam通知にはTeam全体の閲覧権限を要求します。

Workspace直下のPlanning通知もWorkspaceリソースで認可します。担当者向けreminder/overdueには更新権限、ウォッチャーには現在の購読と閲覧権限を要求します。Cognitoグループは全ページを取得して再評価し、SCIM無効化・guest許可・外部ドメイン制限・permission ceilingも適用します。

Workspace全体のAutomation notifyで明示的に選ばれたactiveなguest受信者にも、Inboxと同じ通知を配信します。現在のWorkspace閲覧権限とguest・外部アクセス制限を適用し、TeamやProject、Planningを参照する通知の認可は引き続き各sourceの権限で評価します。

Work Itemの担当者だけに向けた通知は、担当変更・状態変更・日程変更も含め、現在の担当者との一致をInboxと共通の条件で確認します。Cognitoから削除済みの受信者は再試行せず配信を抑止し、一時的なCognito障害のみ再試行します。通知設定は認可処理の後にも読み直し、その間のSlack無効化・quiet hours変更を反映します。

## Email 配信

通知設定の **Email** を有効にすると、担当・メンション・返信・期限・承認などの既存通知を、受信者の Cognito profile にある確認済みのメールアドレスへ 1 通ずつ送ります。送信には Amazon SES（API v2）を使います（[ADR 0005](adr/0005-notification-email-ses-transport.md)）。

### 有効にする

送信は deploy 時の opt-in です。CloudFormation parameter `NotificationEmailSender`（既定は空）に SES で検証した送信元アドレスを 1 つ指定すると有効になります。空のあいだは projection が Email の配信予定を書かず、scheduled job も queue を読まないため、後から有効にしても過去の通知はまとめて送られません。メンバーが Email を選んでも、設定が保存されるだけです（設定画面の「無効」表示は後続で入れます）。

運用者は有効にする前に次を行います。

- SES でこのアドレスか、そのドメインを verified identity にする。本番では sandbox を解除する。
- 送信元ドメインの SPF・DKIM（Easy DKIM）・DMARC を DNS に設定する。
- SES の account-level suppression list を bounce と complaint について有効にしておく。suppression 中の宛先へは SES が送らないため、bounce した宛先へ送り続けることはありません。運用者は SES console の suppression list（`ListSuppressedDestinations`）で確認・削除できます。

Lambda の IAM policy は `ses:SendEmail` を `ses:FromAddress` がこの送信元と一致する場合だけ許可します。本文の deep link はアプリの正規 URL（`NOTIFICATION_EMAIL_APP_ORIGIN`）で絶対 URL にします。stack は `WebDomainName` を指定すればその独自 domain、空なら CloudFront の domain を渡します（[cdk/README.md](../cdk/README.md#独自-domain-で配信する)）。

### 宛先と抑止

宛先は送るたびに、現在の Workspace membership の Cognito username（`username`、なければ email、なければ member key）で `AdminGetUser` を読み、`email_verified` が `true` の `email` だけを使います。membership がない・無効、Cognito user の削除・無効化、未確認アドレスでは配信を抑止し（`emailDeliveryStatus: suppressed`、`emailLastCode` に `EmailRecipientMissing` / `EmailRecipientUnverified`）、alarm は出しません。Cognito の一時障害は再試行します。

有効化時刻は Slack と同じく server が `emailEnabledAt` として保存し、それより前に発生したイベントは送りません。Email transport の導入前から Email を有効にしていた設定は、最後に保存した時刻を境界にします。

### 配信の規則

配信 queue は [Slack 配信](#slack-配信) と同じ実装を使い、属性と index だけが分かれています。通知と同じ transaction で `emailQueueShard`（`email#<番号>`）・`emailNextAttemptAt`・`emailDeliveryStatus`・`emailAttempts` を保存し、16 shard の sparse GSI `EmailDeliveryIndex` から毎分最大32件を処理します。Slack と Email を両方有効にした通知は、それぞれ独立に送ります。どちらの channel の更新も通知 row の `version` を進めるため、一方が期限内の lease を持っている間は他方は claim せず、次の実行で取り直します（互いの送信直前の version 確認を取り消し合わないため）。

再認可・quiet hours と snooze の再確認・lease・version 条件・最大5試行の再試行は Slack と同じです。宛先の読み取りから SES への送信までは合計30秒の期限で打ち切り、送信直前に延長した60秒の lease が切れた後に送ることはありません。frequency は既存の delivery plan の遅延として扱い、通知ごとに 1 通送ります（複数通知を 1 通にまとめる digest ではありません）。SES の throttling（`TooManyRequestsException` など）と一時障害は再試行し、`MessageRejected`・未検証の送信元などは再試行せず失敗にします。応答を失った送信を再試行するため、まれに同じ通知が2通届くことがあります。

本文は ja / en 併記のプレーンテキストです。ただし概要は受信者の言語で 1 回だけ書きます（[概要の文言](#概要の文言)）。言語の読み取りに失敗した通知は送らずに再試行します。件名は `[mukuroji] <タイトル>` で、改行などの制御文字は空白にします。本文には Inbox と同じ deep link を入れ、Web の origin 以外を指す link は使わず Web の top を入れます。

### 失敗の調査

永続的失敗は notification row の `emailDeliveryStatus: failed` と秘密情報を含まない `emailLastCode` に残り、row を `EmailDeliveryIndex` の `email-failed#<番号>` partition へ移して `emailFailureReference` を記録します。CloudWatch の `EmailNotificationFailed` ログの `shard`・`dueAt`・`reference` で Slack と同じ手順で対象を特定できます。ログにはメールアドレスと本文を含めません。`Mukuroji/Notifications` の `OldestDueAgeSeconds`（`Channel: Email`）が15分以上の状態で3回続くと `EmailNotificationBacklogAlarm` を出します。`notification-schedule` runtime control で停止できます。

ローカルでは `floci:up` が index を追加し、`workers:dev` が同じ job を毎分実行します。`NOTIFICATION_EMAIL_SENDER` と `NOTIFICATION_EMAIL_APP_ORIGIN`（loopback 以外は HTTPS）を設定した場合だけ送ります。

## Due / overdue scan

EventBridge の定期 rule が、Work Items table の期限 index（`WorkItemNotificationDueIndex`）から通知の対象になりうる Work Item だけを読みます。index に載るのは archive されていない未完了の Work Item のうち、期限があるものと着手中（`started`）のものだけで、完了・archive・期限の削除で外れます。schedule は 16 の shard を期限の古い順に、今日（UTC）+ 366 日（期限前通知の日数の上限 365 日 + timezone の余裕 1 日）まで読みます。着手中の Work Item は未更新の督促のため期限に関係なく毎回読みます。読み取り量は Work Item の総数ではなく、期限が近い・超過した・着手中の Work Item の数に比例し、page 数の上限はありません。index は結果整合なので、段階が出る item だけ base table を強整合で読み直してから評価します。index の属性（`notificationScheduleShard` と `notificationDueKey`）は Work Item の作成・更新・日程の連鎖更新・承認による状態遷移で同じ書き込みの中で更新します。属性のない既存の row は次に更新されたときに index に載ります。既存 row への一括付与は #365 の migration で行います。Customer 完了通知の marker は別の sparse index（`WorkItemCustomerCompletionPreparationIndex`）から読みます。date-only の期限は各 item の `schedule.calendarPolicy.timeZone` における local calendar day として評価し、未完了かつ担当者がある item に対し、期限当日は `work-item.due`、期限超過後は `work-item.overdue` を作ります。event ID は Workspace、Work Item、due date、reason から決定的に作るため、Lambda retry や翌日の再走査でも同じ due 状態を重複通知しません。

同じ scan は次の段階も作ります。日数は [リマインドの日数](#リマインドの日数) の順で決まり、括弧内は既定値です。

| event type | 宛先 | 条件 | 重複排除の単位 |
| --- | --- | --- | --- |
| `work-item.due-soon` | 責任者 | 期限の 1〜n 日前（`dueSoonDays`、3）。配信が期限当日以降にずれた場合や、配信時点の残日数が scan 時より多い場合は捨てる | 期限・責任者・calendar の timezone |
| `work-item.overdue-reminder` | 責任者 | 期限日から数えて interval 日ごと（`overdueReminderIntervalDays`、7）。初回の通知を受けた日ではなく期限日を起点に数えるため、超過から時間が経って初めて走査された item は、すでに過ぎた回の再通知を 1 回だけ受けます。初回の超過は従来どおり `work-item.overdue` で、超過中は毎回同じ key で試行するため、超過から時間が経って初めて走査された item にも一度だけ出る | 期限・責任者・何回目か |
| `work-item.overdue-escalation` | 割り当て先 Project の現在の manager（archive 済みの membership と責任者本人を除く） | 超過 n 日以上（`overdueEscalationDays`、7。Team 設定だけで決まり、個人設定では変えられない）。Project 未割り当ての Work Item は対象外。manager ごとに別 event にし、配信時点の超過日数が scan 時より少なければ捨てる | 期限・Project・manager・calendar の timezone・再開時刻 |
| `work-item.stale` | 責任者 | `started` のまま n 日更新なし（`staleStartedDays`、7）。n 日ごとに再通知。期限超過中は超過の再通知に任せて送らない。配送時に期限を過ぎていた場合も捨てる | 最終更新時刻・責任者・何回目か |

期限前・再通知・escalation の概要文は「あと n 日」ではなく期限日そのものを書きます。quiet hours や digest で配信が翌日以降にずれても内容が古くならないためです。再通知は `work-item.overdue` と別の event type にしているため、Automation の `due` trigger（`overdue`）は初回だけ発火します。archived の Work Item はどの段階も作りません。projection は配送時に Work Item を強整合で読み直し、完了・archive・期限変更・責任者変更・更新済みの段階と、別 Project へ移った後の escalation を捨てます。escalation の宛先は schedule が notifications の application port（`ScheduledProjectManagerReader`）経由で読み、Project Directory の DynamoDB 実装は composition root で注入します。配送時点でも Project manager であることを確認します。schedule event は scan 時の残日数（`daysUntilDue`、超過時は負）を metadata に持ち、通知行にも保存します。projection と Slack 送信時の再認可は、Work Item の calendar での今日と比べて段階を再判定します。通知の保存 transaction は読み直した Work Item の `revision` を条件にするため、読み直しと保存の間に Work Item が更新されると stream の retry で再判定します。due-soon と escalation の重複排除 key には Work Item の calendar の timezone を含めます。timezone の変更で配信時に捨てた段階を、新しい calendar で条件を満たしたときに出し直せるようにするためです（timezone を変えた直後は同じ段階が再度届くことがあります）。期限当日の `work-item.due` は配信時点でも期限当日のとき、`work-item.overdue` と再通知は配信時点でも期限を過ぎているときだけ届けます。`due` と `overdue` の key は timezone を含まないため、timezone の変更で期限当日に戻って捨てた初回の超過通知は出し直さず、次の再通知に任せます。

escalation は Work Item が完了・中止・archive で配信時に捨てられることがあります。Work Item を未完了に戻すか archive を解除すると、Work Item の `reopenedAt` を更新し、escalation の重複排除 key に含めます。そのため、再開後も同じ期限・Project・manager の条件を満たしていれば、次の scan で escalation を出し直します。再開した時点で超過日数が条件を満たしていれば、前に届いた escalation があっても manager にもう一度届きます。escalation の event と通知行は scan 時の `reopenedAt` を `workItemReopenedAt` として持ち、projection と Slack 送信時の再認可は現在の Work Item の `reopenedAt` と一致しない escalation を捨てます。そのため、再開前に作られて配信待ちだった escalation と、再開後の escalation が両方届くことはありません。

### リマインドの日数

期限前・再通知・escalation・未更新の督促・工数の督促の日数は、受け取る人ごとに次の順で決めます。

1. 本人の通知設定（`reminderDays`）。escalation（`overdueEscalationDays`）は Project manager に届くため、本人は変えられません
2. Work Item（工数の督促では工数）の Team の設定（`GET` / `PUT /api/teams/{teamId}/notification-reminders`）
3. 既定値。stack parameter `NotificationReminderDefaultDays` の 1 か所で上書きでき、空（既定）なら 3 / 7 / 7 / 7 / 7 日です。値は Team の設定と同じ field の JSON object で、書いた field だけを上書きします（例: `{"dueSoonDays":5,"timesheetReminderDays":14}`）。CDK はこの parameter を環境変数 `NOTIFICATION_REMINDER_DEFAULT_DAYS` として schedule と API の両方の Lambda に渡すため、Team 設定の API が `defaults` として返す値と schedule が使う値は常に同じです。知らない field や範囲外の日数は、schedule の各実行と Team 設定 API の各要求でエラーにします（Lambda の起動時には検証しません）

日数は 1〜365 の整数です。ただし `timesheetReminderDays` は 1〜31 です（督促は過去 92 日の工数しか見ないため、それより長い日数では督促が届かなくなります）。Team の設定は Team を読める member なら誰でも読め（`canManage` で変更できるかを返します）、変更は Team manager かつ Workspace の業務データを書ける人だけができます。route の `teams.manage` と handler の `requireTeamPermission(..., 'manager')` の両方で確認し、body は認可の後に検証します。保存は `expectedRevision` を条件にした transaction で、変更前後の日数を `notification-reminders.updated` の audit event に同じ transaction で残します。`Idempotency-Key` 付きの保存は、key ごとの receipt 行（sort key `TEAM#<teamId>#MUTATION#<key の sha256>`）に request の fingerprint と保存した設定を同じ transaction で残します。応答が失われた後に同じ key・同じ body で再送されたときは、間に別の保存があっても revision の競合にせず、その key で保存した設定を返します。同じ key で別の body を送ると 409 `IdempotencyKeyReused` です。保存の transaction には呼び出し元の Workspace member 行の `version` と Enterprise の CONTROL revision の ConditionCheck も入れ、認可の確認から保存までに権限が変わった場合は 409 `TeamReminderSettingsAuthorizationChanged` で取り消します。保存済みの行は要求した Workspace と Team の ID を持つことも確かめ、壊れた行や別の scope の行は既定値に戻さずエラーにします。個人の `reminderDays` が壊れている場合も、通常の設定の読み取りと継承する保存を含めてエラーにします。Team の設定は NotificationsTable の `<workspaceId>#!team-reminder-settings` partition に Team ごとの行として保存します。member key は必ず `@` を含むので member の partition と衝突せず、`<workspaceId>#` で始まるので Workspace の削除・export の範囲に入ります。

Team と本人の設定は schedule の 1 回の実行の中で Team・member ごとに 1 回だけ読みます。Team の行が壊れている場合は既定値に戻さず、schedule を失敗させて retry と alarm に任せます。

日数を変えると、再通知と未更新の督促の「何回目か」の数え方が変わります。既定値以外の interval は重複排除 key に interval を含め、別の interval で送った回と混ざらないようにします。既定値の interval は key に含めないため、設定を導入する前に送った回と同じ key のままです。期限前通知は日数を変えても期限ごとに 1 回だけです。

### 工数の督促

`timesheet.submission-reminder` は、工数 entry が終わってから n 日（`timesheetReminderDays`、7）たっても `draft` または `rejected` のままの人に、Team の Project ごとに 1 通届きます。未提出の entry が残る間は n 日ごとに届きます。

- schedule は 1 時間ごとに動きますが、工数の督促を作るのは 1 日 1 回、Workspace の time zone（今はすべての Workspace が `Asia/Tokyo`）で `NOTIFICATION_TIMESHEET_REMINDER_HOUR` 時（既定 9 時）の実行だけです。時刻は Workspace の時計で判定するため、夏時間のある time zone でも同じ現地時刻に届きます。その回が失敗した日は送らず、翌日の実行で送ります
- 対象は Project directory にある全 Team です（その回だけ directory を読みます。読む量は Work Item の数ではなく Team・Project・member の数に比例します）。Team ごとに `TimeEntryTeamDateIndex` を直近 92 日分だけ読みます。それより前に始まった未提出の entry は督促しません
- 重複排除 key は Workspace・Team・member・Project・n・「Unix epoch から数えて何番目の n 日か」です。同じ期間の再実行や retry は同じ event になります
- 通知は Inbox の「工数の提出」として届き、最も古い未提出 entry の週の工数画面（`/teams/{teamId}/timesheet?week=<entry の開始時刻>`。ブラウザが閲覧者の timezone でその時刻を含む週（Workspace の週の始まりの曜日に合わせる）に直します）を開きます。title は持たず、概要は件数と最も古い日付です
- 対象は Project に紐づく entry だけです。Project のない entry は一般の member の工数画面に出ず、そこから提出できないため督促しません
- event は古い順に最大 20 件の entry ID を持ちます。projection は配信時にその entry を強整合で読み直し、本人の `draft` / `rejected` で、同じ Project に属し、scan 時の期限（その時点から n 日前）までに終わっている entry が 1 件も残っていなければ捨てます。日付を直して期限より後に終わる entry になった場合も数えません。残っていれば、その entry の revision を条件にした ConditionCheck を通知の保存と同じ transaction に入れるため、読み直しと保存の間に提出されると保存は取り消され、retry で読み直して捨てます。読み直す手段がない projection では督促を届けません
- 宛先の権限は、その Project の通知として確認します（その Project を読めること）。Inbox・Slack・Email のどれでも同じで、Team の全 Project を読める必要はありません。読めなくなった Project の entry は、ほかの Project の督促を止めません
- Slack と Email への配信も、送信の直前に同じ entry を強整合で読み直します。通知行は event の entry ID（`timeEntryIds`）と期限（`timesheetDueBefore`）を持ち、projection と同じ条件で未提出の entry が 1 件も残っていなければ送らずに `suppressed` で終えます。quiet hours や digest で送信が遅れる間に提出した場合も、古い督促は届きません。entry ID を持たない行と、読み直す手段（`ANALYTICS_TABLE_NAME`）のない送信 job では督促を送りません。読み直しから送信までの間に提出した場合は、まれに届くことがあります

### 週報の督促

週報（ADR 0030）を出していない人に、週に 1 回 `weekly-report.submission-reminder` が届きます。出さないまま週が明けると、その人が書いている Project の manager に `weekly-report.submission-escalation` が届きます（ADR 0035）。

- 時刻は Workspace ごとの設定で、tenant profile の `weeklyReportReminders`（`enabled`・`reminder`・`escalationEnabled`・`escalation`、時刻は `{ weekday: 0〜6, hour: 0〜23 }`）に保存します。**設定** → **Workspace 管理** → **テナント管理** で、`PATCH /api/tenant/profile`（owner / admin、Enterprise では `workspace.manage`、`expectedRevision` の比較つき）から変えます。保存していない Workspace は既定（本人へ金曜 17 時、manager へ月曜 10 時）です。時刻は日本時間（`Asia/Tokyo`）で読みます。schedule は 1 時間ごとで、毎回 Workspace ごとに tenant profile を読み、その時の実行で 1 回だけ作ります。失敗した回は送りません。本人への督促を止めると manager への通知も止まります。閉鎖中・閉鎖済みの Workspace には送りません。両方を有効にして同じ曜日・時刻にはできません（`400 InvalidWeeklyReportReminderSettings`）
- 対象の週は、督促の日を含む Workspace の週（tenant profile の calendar の `weekStartDay`、未設定なら月曜始まり）です。manager への通知は、直近の督促の日を含む週について出します（既定では金曜を含む週）
- 書く人は、Team の active な Project に unarchived の `manager` / `member` で入っている人です。viewer、archive 済みの Team・Project・membership、複数の Team が同じ ID を使う Project は除きます。Enterprise の role だけで入っていて membership 行がない人は対象外です
- 未提出は、週の行（`WEEKLY_REPORT#<team>#MEMBER#<member>#W#<week>`）がないか `submissionCount` が 0 のことです
- 本人への督促は Team ごとに 1 通で、本人が書いている最初の Project（ID 順）の通知として認可します。manager への通知は作成者 × manager ごとに 1 通で、作成者本人には送りません。重複排除 key は Workspace・Team・週・種類・作成者・宛先です
- 通知は Inbox の「週報の提出」として届き、本人は `/teams/{teamId}/timesheet?view=weekly-report&week=<週の開始日>`、manager は `view=team-weekly-reports` の同じ週を開きます。概要は週の開始日と、manager 向けには作成者の表示名です
- projection は配信時に週の行を強整合で読み直し、提出済みなら捨てます。未提出なら「週の行がないか `submissionCount = 0`」の ConditionCheck を通知の保存と同じ transaction に入れるため、読み直しと保存の間に提出されると保存は取り消され、retry で捨てます。読み直す手段がない projection では届けません
- 宛先の権限は event の Project の通知として確認し、さらに作成者がその Project に `manager` / `member` で残っていること、manager への通知では宛先がその Project の manager であることを、projection と Slack・Email の送信時の両方で確かめます
- Slack と Email への配信も、送信の直前に同じ週の行を強整合で読み直します。通知行は作成者（`weeklyReportAuthorMemberKey`）と週の開始日（`weeklyReportWeekStart`）を持ち、提出済みなら送らずに `suppressed` で終えます。quiet hours や digest で送信が遅れる間に提出した場合も、古い督促は届きません。manager への通知も、作成者が提出していれば届きません。週の開始日を持たない行と、読み直す手段（`PLANNING_TABLE_NAME`）のない送信 job では督促を送りません。読み直しから送信までの間に提出した場合は、まれに届くことがあります

期限境界の authoritative time zone は各 Work Item の canonical schedule が所有します。Notification scan と Web の due/overdue 表示は同じ `schedule.calendarPolicy.timeZone` を使用し、実行環境や viewer の local timezone から期限状態を推測しません。
