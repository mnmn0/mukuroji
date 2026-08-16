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

- `COMMENT#...`: Markdown source、root/parent comment、version、編集・削除・解決状態。root row は current accepted resolution を指す `acceptedResolutionId` pointer も保持
- `CONTEXT#...`: curated context item の current snapshot。本文、分類、状態、version、capture 時点の provenance を保持
- `CONTEXT_ORDER#...`: context item 一覧を cursor page するための作成日時順 projection
- `CONTEXT_REVISION#...`: context item の append-only revision snapshot
- `CONTEXT_RECEIPT#...`: context mutation の idempotency identity と immutable response revision を結ぶ append-only receipt
- `RESOLUTION#<rootCommentId>#<recordedAt>#<stateRank>#<resolutionId>#<state>`: accepted resolution の accepted / superseded snapshot を保持する append-only history row。同時刻の mutation では accepted を先に返す rank を持ち、旧 rank なし key も読み取り互換を維持
- `RESOLUTION_RECEIPT#...`: accepted resolution mutation の response-loss retry を後続 mutation 後も再構成する deterministic receipt
- `REACTION#...`: comment、emoji、member の一意な組み合わせ
- `WATCHER#...`: member ごとの manual/automatic watch 理由と明示的な unsubscribe
- `PRESENCE#...`: browser session ごとの typing/presence lease。`expiresAt` で自動削除

Comment は物理削除しません。現在の本文を tombstone に置き換え、reply の文脈と audit event を保持します。編集、削除、resolve/reopen、reaction、watch の各 mutation は、state update と append-only audit event を同じ DynamoDB transaction に入れます。

Accepted resolution の receipt は採用結果と captured reply evidence だけを復元できる形に制限し、root comment 本文や mention を保持しません。response-loss retry では current root を consistent read し、後続の編集・削除で取り除かれた root 本文を再公開しません。

Context item は current snapshot を optimistic revision 条件で更新し、同じ transaction で revision row と audit event を追記します。source は current item から in-place に変更・解除できません。根拠を変更するときは旧 item を `superseded` にする atomic replacement を作成し、新旧双方の snapshot を履歴として残します。置き換え request が source を省略した場合は、権限喪失後も再取得を試みず、旧 item の immutable provenance snapshot を新 item へ引き継ぎます。採用回答を差し替えたり要約を編集した場合も、以前の回答を上書きせず `superseded` にして履歴を保持します。同じ回答の手動 summary を編集するときは、回答が後から編集・削除されていても、最初に採用した本文と revision を新しい history row へ引き継ぎます。

Thread API は root を標準 10 件（最大 20 件）、各 root の最新 reply preview を 5 件に制限します。Root と reply はそれぞれ scope-bound cursor で続きを取得し、1 request による hot partition への集中を抑えます。Context item と immutable revision は最大 10 件、accepted resolution history も標準・最大 10 件の独立した cursor page で返します。通常の root response は current accepted resolution だけを保持し、長い編集・差し替え履歴を thread page へ無制限に埋め込みません。

Work Item と assigned project はそれぞれ独立に手動購読・解除できます。Work Item 作成者、担当者、comment 作成者、mention 対象、reply 先作成者は自動 watcher 候補となります。ユーザーが明示的に解除した tombstone は自動購読より優先されます。

## Mention と通知

Composer は表示ラベルとは別に安定した Workspace member key を送信します。API は次を検証します。

1. member が active であること
2. 対象 Work Item を閲覧できること
3. 同じ member が複数の mention/watch/reply 条件に該当しても recipient を一度だけ選ぶこと
4. actor 自身を通知対象から除外すること

Audit event の private metadata には件数上限のある mention/reply candidate と deep link を保存します。Watcher は大規模 project でも audit item の 400 KB 上限を超えないよう、AuditEvents stream consumer が Collaboration table を page 読みして配送時に解決します。consumer は現在の権限と membership を再確認して Notifications table へ投影します。notification ID は event と recipient から決定的に作成し、processed receipt と同じ transaction に保存するため、stream retry でも重複しません。

Context item の作成者、更新者、mention 対象も同じ watcher / notification candidate の規則に従います。通知は current membership と閲覧権限を配送時にも再検証します。

## Source provenance と履歴

Context item は capture 時点の原文、選択した引用、permalink、actor、発生日時、source revision を provenance snapshot として保持します。保存後に元 comment が編集された場合、context read は本文を差し替えず `edited` と current revision を返します。元 comment が soft delete された場合も、保持済みの原文と引用を消さず `deleted` として明示します。Activity source は AuditEvents table の物理 TTL 削除を待たず、`expiresAt` に達した時点で新規 capture を拒否し、既存 snapshot は `retention-expired` として表示します。

外部 chat や document では、provider / resource の current access が確認できない状態を成功扱いにしません。権限喪失は `permission-lost`、retention による消失は `retention-expired` として区別し、source ID、actor、発生日時、revision、unavailable reason は監査・判断履歴として残します。retention 期限後の原文・引用・permalink は response から除外し、別 table への capture で保持期限を迂回しません。External chat の current source 読み込みは既存の provider-neutral external-chat contract と permission check を通す必要があります。現時点では production provider adapter / composition がないため、API は provider へ直接接続せず、未構成の external source capture を安定した unavailable error として返します。

Canonical snapshot は履歴として保持しても、current viewer の source permission を確認できない response では原文、引用、permalink を返しません。`kind`、source ID、container ID、actor/time/revision と安全な unavailable reason だけを返し、Work Item の閲覧権限を source 本文の閲覧権限として流用しません。

Context item の作成・更新・差し替え audit は AuditEvents stream consumer から Workspace Search へ再投影します。同期 response 後の best-effort projection が失敗しても、processed receipt より前の stream retry が current snapshot の upsert または superseded document の delete に収束します。

## Permission

- 読み取り、watch、presence: team と assigned project の viewer 権限
- comment、reply、reaction、typing: active な非 guest member と assigned project の member 権限
- context create/edit/replace: active な非 guest member と assigned project の member 権限。replace は旧 item を `superseded` にして履歴を残す
- edit: comment author。管理者による本文の書き換えは行わない
- delete: comment author、assigned project（未割当て時は所有 team 配下）の manager、Workspace owner/admin、system admin
- resolve/reopen: root comment author、Work Item assignee、assigned project（未割当て時は所有 team 配下）の manager、Workspace owner/admin、system admin
- accepted resolution: 同じ thread の未削除 reply のみを選択でき、root comment author、Work Item assignee、assigned project（未割当て時は所有 team 配下）の manager、Workspace owner/admin、system admin が、空でない手動 summary を付けて選択・差し替え・編集できる

退会・deactivated user の過去 comment は author key を保持して表示できますが、新しい mutation や通知の recipient にはなりません。権限を失った user は thread API、notification projection、realtime subscription のすべてで除外します。

## Rich text safety

保存するのは HTML ではなく Markdown source です。本文は長さと制御文字を API で検証し、Web は Markdown AST を `rehype-sanitize` で sanitize してから表示します。raw HTML は有効化せず、link scheme は `https`、`http`、`mailto` に限定します。これにより fenced/inline code、link、GFM checklist を扱いつつ、script、event handler、危険な URL を DOM に渡しません。

## Realtime と競合更新

Presence と typing は短い TTL を持つ lease です。WebSocket 接続が利用できる環境では scope ごとの invalidation を push し、client は認可済み HTTP API から最新 snapshot を再取得します。接続中の message と fan-out でも active membership、Work Item の現在の assigned project、team/project の archive、現在の project role と書き込み権限を再確認します。system admin の project bypass は Cognito の現在 group membership を毎回再検証し、ticket の古い snapshot だけでは継続できません。認可 snapshot には延長できない有効期限を設け、ローカル環境や接続断では数秒間隔の polling に切り替えます。

Comment edit/resolve/delete は `expectedVersion` を要求します。読み込み後に別 user が変更した場合は `409 CommentVersionConflict` を返し、client は最新内容を再取得します。push/polling は表示の鮮度を上げる仕組みであり、整合性の最終防衛線は version 条件です。

## Canonical comment reads

Comment と reply の response は、移行完了 marker がある workspace では Collaboration table に保存された canonical row だけを返します。`TeamIssueEventsTable` の旧 `commented` event は activity/audit 用途として保持します。marker がない workspace では、backfill が完走するまで旧 event を read-only の一時 fallback として返し、Collaboration cursor と区別した `legacy.` cursor で続きの page を取得します。旧 event から返した comment の mutation capability はすべて無効です。

## Legacy comment backfill

旧 `commented` event は、workspace 単位の完了 marker が書かれるまで削除・非表示にしません。backfill は source event ID を canonical comment ID として使い、comment と root discussion row を条件付きで保存するため、checkpoint を使った中断・再実行に耐えます。Work Item が存在しない、row の scope が partition key と一致しない、既存 canonical row の内容が異なる場合は fail-closed で停止します。通知・audit は backfill から生成しません。

まず dry-run で source row を検証し、その後 checkpoint を指定して実行します。source table の全 scan が完了した後にだけ、検出した各 workspace の marker が保存されます。

```sh
AWS_ENDPOINT_URL=http://localhost:4566 bun run team-issue-comments:backfill -- --dry-run --limit 100
AWS_ENDPOINT_URL=http://localhost:4566 bun run team-issue-comments:backfill -- \
  --checkpoint /tmp/mukuroji-team-issue-comments-v1.json
```

AWS では `TEAM_ISSUE_EVENTS_TABLE_NAME`、`COLLABORATION_TABLE_NAME`、`TEAM_ISSUES_TABLE_NAME` を明示してください。checkpoint には DynamoDB の continuation key が含まれるため owner-only で保存され、移行完了後に削除します。source/target table、region、workspace filter が異なる checkpoint は拒否されます。
特定 workspace だけを先に処理する場合は `--workspace-id <id>` を繰り返し指定できます。その場合も指定 workspace の source scan が末尾まで到達した後にだけ marker が保存されます。
