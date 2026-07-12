# Collaboration threads

Mukuroji のコメント、返信、watch、reaction、mention 通知、presence は、Work Item の活動履歴と同じ workspace scope で扱います。

## Scope と互換性

現行の write model は team-owned Issue です。canonical Work Item への移行が完了するまでは、次の ID を collaboration と audit の共通 ID として使用します。

```text
team/<teamId>/issue/<issueId>
```

Collaboration table の partition key は workspace ID、entity type、上記 entity ID から構成します。Project watch は `project/<projectId>` を別 scope として保存します。legacy project task は read-only のため、新しい comment mutation の対象にはしません。

## 保存モデル

Collaboration table は `entityKey` と `recordKey` を primary key に持ちます。

- `COMMENT#...`: Markdown source、root/parent comment、version、編集・削除・解決状態
- `REACTION#...`: comment、emoji、member の一意な組み合わせ
- `WATCHER#...`: member ごとの manual/automatic watch 理由と明示的な unsubscribe
- `PRESENCE#...`: browser session ごとの typing/presence lease。`expiresAt` で自動削除

Comment は物理削除しません。現在の本文を tombstone に置き換え、reply の文脈と audit event を保持します。編集、削除、resolve/reopen、reaction、watch の各 mutation は、state update と append-only audit event を同じ DynamoDB transaction に入れます。

Thread API は root を標準 10 件（最大 20 件）、各 root の最新 reply preview を 5 件に制限します。Root と reply はそれぞれ scope-bound cursor で続きを取得し、1 request による hot partition への集中を抑えます。

Work Item と assigned project はそれぞれ独立に手動購読・解除できます。Work Item 作成者、担当者、comment 作成者、mention 対象、reply 先作成者は自動 watcher 候補となります。ユーザーが明示的に解除した tombstone は自動購読より優先されます。

## Mention と通知

Composer は表示ラベルとは別に安定した Workspace member key を送信します。API は次を検証します。

1. member が active であること
2. 対象 Work Item を閲覧できること
3. 同じ member が複数の mention/watch/reply 条件に該当しても recipient を一度だけ選ぶこと
4. actor 自身を通知対象から除外すること

Audit event の private metadata には件数上限のある mention/reply candidate と deep link を保存します。Watcher は大規模 project でも audit item の 400 KB 上限を超えないよう、AuditEvents stream consumer が Collaboration table を page 読みして配送時に解決します。consumer は現在の権限と membership を再確認して Notifications table へ投影します。notification ID は event と recipient から決定的に作成し、processed receipt と同じ transaction に保存するため、stream retry でも重複しません。

## Permission

- 読み取り、watch、presence: team と assigned project の viewer 権限
- comment、reply、reaction、typing: active な非 guest member と assigned project の member 権限
- edit: comment author。管理者による本文の書き換えは行わない
- delete: comment author、assigned project（未割当て時は所有 team 配下）の manager、Workspace owner/admin、system admin
- resolve/reopen: root comment author、Work Item assignee、assigned project（未割当て時は所有 team 配下）の manager、Workspace owner/admin、system admin

退会・deactivated user の過去 comment は author key を保持して表示できますが、新しい mutation や通知の recipient にはなりません。権限を失った user は thread API、notification projection、realtime subscription のすべてで除外します。

## Rich text safety

保存するのは HTML ではなく Markdown source です。本文は長さと制御文字を API で検証し、Web は Markdown AST を `rehype-sanitize` で sanitize してから表示します。raw HTML は有効化せず、link scheme は `https`、`http`、`mailto` に限定します。これにより fenced/inline code、link、GFM checklist を扱いつつ、script、event handler、危険な URL を DOM に渡しません。

## Realtime と競合更新

Presence と typing は短い TTL を持つ lease です。WebSocket 接続が利用できる環境では scope ごとの invalidation を push し、client は認可済み HTTP API から最新 snapshot を再取得します。接続中の message と fan-out でも active membership、Work Item の現在の assigned project、team/project の archive、現在の project role と書き込み権限を再確認します。system admin の project bypass は Cognito の現在 group membership を毎回再検証し、ticket の古い snapshot だけでは継続できません。認可 snapshot には延長できない有効期限を設け、ローカル環境や接続断では数秒間隔の polling に切り替えます。

Comment edit/resolve/delete は `expectedVersion` を要求します。読み込み後に別 user が変更した場合は `409 CommentVersionConflict` を返し、client は最新内容を再取得します。push/polling は表示の鮮度を上げる仕組みであり、整合性の最終防衛線は version 条件です。

## Legacy migration

既存の `TeamIssueEventsTable` にある `commented` row は、同じ comment ID と作成日時を使って collaboration comment へ backfill できます。Backfill は notification を生成せず、audit event では `outboxStatus=suppressed` とします。移行期間中は persisted root page を読み終えた後、legacy event を新しい順に最大 50 件ずつ評価し、`commented` row を read-only comment として統合します。opaque cursor で event partition の末尾まで継続できるため、全件一括読込と無制限な response 拡大を避けながら過去 comment へ到達できます。backfill 済み ID と legacy row が別 page に現れた場合も Web は persisted comment を優先します。migration marker の確認後に fallback を削除します。
