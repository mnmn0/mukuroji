# Collaboration threads

Mukuroji のコメント、返信、watch、reaction、mention 通知、presence は、Work Item の活動履歴と同じ workspace scope で扱います。

## Scope と互換性

現行の write model は team-owned Issue です。canonical Work Item への移行が完了するまでは、次の ID を collaboration と audit の共通 ID として使用します。

```text
team/<teamId>/issue/<issueId>
```

Collaboration table の partition key は workspace ID、entity type、上記 entity ID から構成します。Project watch は `project/<projectId>` を別 scope として保存します。

## 保存モデル

Collaboration table は `entityKey` と `recordKey` を primary key に持ちます。

- `COMMENT#...`: Markdown source、root/parent comment、version、編集・削除・解決状態。root row は current accepted resolution の snapshot と、それを指す `acceptedResolutionId` pointer だけを保持し、履歴は埋め込まない
- `CONTEXT#...`: curated context item の current snapshot。本文、分類、状態、version、capture 時点の provenance を保持
- `CONTEXT_ORDER#...`: context item 一覧を cursor page するための作成日時順 projection
- `CONTEXT_REVISION#...`: context item の append-only revision snapshot
- `CONTEXT_RECEIPT#...`: context mutation の idempotency identity と immutable response revision を結ぶ append-only receipt
- `RESOLUTION#<rootCommentId>#<recordedAt>#<stateRank>#<resolutionId>#<state>`: accepted resolution の accepted / superseded snapshot を保持する append-only history row。同時刻の mutation では accepted を先に返す rank を持つ
- `RESOLUTION_RECEIPT#...`: accepted resolution mutation の response-loss retry を後続 mutation 後も再構成する deterministic receipt
- `REACTION#...`: comment、emoji、member の一意な組み合わせ
- `WATCHER#...`: member ごとの manual/automatic watch 理由と明示的な unsubscribe
- `PRESENCE#...`: browser session ごとの typing/presence lease。`expiresAt` で自動削除

Comment は物理削除しません。現在の本文を tombstone に置き換え、reply の文脈と audit event を保持します。編集、削除、resolve/reopen、reaction、watch の各 mutation は、state update と append-only audit event を同じ DynamoDB transaction に入れます。

Accepted resolution の receipt は採用結果と captured reply evidence だけを復元できる形に制限し、root comment 本文や mention を保持しません。response-loss retry では current root を consistent read し、後続の編集・削除で取り除かれた root 本文を再公開しません。

Accepted resolution の正本は root row の current snapshot / pointer と `RESOLUTION#...` history row だけです。履歴を埋め込んだ root row、pointer と snapshot が一致しない root row、上記の rank 付き形式と一致しない history key は、読み飛ばさず `503 InvalidCollaborationRecord` で fail closed します。

Context item は current snapshot を optimistic revision 条件で更新し、同じ transaction で revision row と audit event を追記します。source は current item から in-place に変更・解除できません。根拠を変更するときは旧 item を `superseded` にする atomic replacement を作成し、新旧双方の snapshot を履歴として残します。置き換え request が source を省略した場合は、権限喪失後も再取得を試みず、旧 item の immutable provenance snapshot を新 item へ引き継ぎます。採用回答を差し替えたり要約を編集した場合も、以前の回答を上書きせず `superseded` にして履歴を保持します。同じ回答の手動 summary を編集するときは、回答が後から編集・削除されていても、最初に採用した本文と revision を新しい history row へ引き継ぎます。

Thread API は root を標準 10 件（最大 20 件）、各 root の最新 reply preview を 5 件に制限します。Root と reply はそれぞれ scope-bound cursor で続きを取得し、1 request による hot partition への集中を抑えます。Context item と immutable revision は最大 10 件、accepted resolution history も標準・最大 10 件の独立した cursor page で返します。通常の root response は current accepted resolution だけを保持し、長い編集・差し替え履歴を thread page へ無制限に埋め込みません。Accepted resolution history の cursor は entity key、root comment、読み込み時の root version と current pointer、最後に読んだ history row key に束縛します。root が変わった場合は `409 AcceptedResolutionHistoryConflict`、別 scope や history row key を持たない cursor は `400 InvalidCollaborationCursor` で拒否します。

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

Context item の作成・更新・差し替え audit は AuditEvents stream consumer から Workspace Search へ再投影します。同期 response 後の best-effort projection が失敗しても、processed receipt より前の stream retry が current snapshot の upsert または superseded document の delete に収束します。Search 投影は event の processed receipt とは別の receipt を持ち、親 Work Item の存在と assigned project が投影時から変わっていないことを条件に、notification 投影より前に記録します。親 scope が変わった場合は古い document を削除して stream retry に戻し、Search receipt がある retry は Search を再投影せず notification 投影から再開します。processed receipt がある event は再処理しません。

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

## Canonical comment source

Collaboration comment の正本は Collaboration table の root/reply row (`COMMENT#...`) だけです。Web の会話 UI、Public API、MCP の comment 一覧はすべてこの row から読み、Team Issue detail API (`GET /api/teams/<teamId>/issues/<issueId>`) は comment を含めません。`TeamIssueEventsTable` は Work Item の activity と duplicate Triage context を保持する event log であり、comment の読み取りには使いません。

Comment 作成 API は `bodyMarkdown` を必須とし、作成した canonical comment と対応する activity を返します。Collaboration API と comment mutation API が返す comment は、常に `acceptedResolutions` と、`canEdit`、`canDelete`、`canResolve`、`canReply`、`canReact`、`canAttach`、`canPromote` の全 capability を含みます。

Comment 作成 transaction は comment row と同時に、次の discussion index row を条件付きで保存します。

- `DISCUSSION#V2S#ROOT#<createdAt>#<commentId>` と `DISCUSSION#V2S#THREAD#<rootCommentId>#<createdAt>#<commentId>`: root 一覧と thread ごとの reply 一覧を新しい順に読む scoped index
- `DISCUSSION#V2#<createdAt>#ROOT#<commentId>` と `DISCUSSION#V2#<createdAt>#THREAD#<rootCommentId>#<commentId>`: root と reply を一つの時系列で読む timeline index

Root page と reply page の cursor は entity key と index prefix に束縛した opaque cursor です。Public API の comment 一覧は timeline index を新しい順に読み、各 row が comment と一致することを検証したうえで、entity key と page size に束縛した境界 cursor で続きを返します。別 scope、別 page size、または別形式の cursor は `400 InvalidCollaborationCursor` で拒否します。
