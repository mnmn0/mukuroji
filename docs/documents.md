# Document・Wiki・Whiteboard

Document 機能は page、folder、template、whiteboard を同じ tree と権限モデルで扱います。
Canonical schema は `@mukuroji/contracts`、永続化と認可は
`server/src/documents.ts`、HTTP route は `server/src/document-api.ts` にあります。

## データモデル

すべての current Document は `DocumentsTable` の Workspace partition に保存します。

- current Document: `DOCUMENT#<documentId>`
- immutable version metadata: `VERSION#<documentId>#<revision>`
- immutable version snapshot: `VERSION_SNAPSHOT#<documentId>#<revision>`
- operation receipt: `OPERATION#<documentId>#<operationId>`
- child index: `DOCUMENT_CHILD#<parentId>#<documentId>`
- favorite / recent preference: user と Document の組み合わせ。内部 revision で CAS 更新
- recent index: user、reverse timestamp、Document の組み合わせ
- comment / presence / public share: Document ごとの row
- backlink: target kind・target ID・source Document の組み合わせ

Public link の raw token は保存せず、SHA-256 digest だけを lookup row と share row に保存します。
Response loss 後の同一 `Idempotency-Key` 再送では、server-only secret を使う HMAC から同じ bearer
token を復元します。Idempotency header や Workspace ID だけでは public URL を導出できません。
Presence と public link の cleanup には `expiresAtEpoch` の DynamoDB TTL を使い、API でも expiry を
再検証します。Current Document と version は point-in-time recovery を有効にした retained table
へ保存します。

Page と template は block 配列を持ちます。Paragraph、heading、table、code、checklist、
embed、diagram を canonical block として保存します。Whiteboard は object、connector、frame を
保存し、Work Item object と relation の両方を検索・backlink の対象にできます。

## 同時編集と履歴

Client は `baseRevision`、`clientId`、一意な `operationId` を付けて operation batch を送ります。
Server は block / object / connector / frame / relation ごとの最終更新 revision を比較します。
Batch は DynamoDB transaction と backlink 更新を常に atomic に収めるため最大 4 operation です。

- 別 element の更新は stale な `baseRevision` からでも現在 snapshot へ merge します。
- 同じ element が更新済みの場合は batch 全体を `409 DocumentOperationConflict` で拒否します。
- 同じ `operationId` と同じ内容の再送は二重適用しません。
- 同じ `operationId` を異なる内容で使うと idempotency conflict にします。
- 確定した mutation ごとに immutable version snapshot を保存します。
- Restore は過去 snapshot を上書きせず、新しい revision として保存します。
- Restore が再導入する relation / Whiteboard Work Item target は current source of truth で
  再認可し、権限を失った target を過去 snapshot から復活させません。

Presence は user / Document ごとに一つの置換可能な短い lease として保存します。画面は
heartbeat と polling を行い、期限切れ collaborator を表示しません。一覧は評価件数と返却件数を
制限し、任意の `clientId` を大量に作ることで他 user を押し出せない構造です。

Comment は root / reply、block・text・whiteboard object anchor を保持します。解決済み root
への reply は、reply 保存 transaction 内でも root の未解決状態を condition check して拒否します。
Mention は active Workspace member を検証し、comment と同じ transaction で audit event を保存
します。通知一覧を返す直前にも current Document ACL を再評価するため、通知作成後に private
化・archive された Document は表示されません。

Favorite と最終 open 時刻は、preference revision の条件付き transaction を競合時に再試行して
未指定 field を保持します。Recent index の旧 key 削除と新 key 保存も同じ transaction に含め、
遅れて到着した open request で新しい時刻を巻き戻しません。

Template の block snapshot は複製しますが、source の direct member grant は destination page
へ持ち越しません。新しい page は destination の parent / scope から権限を継承します。

## 権限

Document API は active Workspace membership と現在の Project role を認証層から受け取り、
すべての read / write で store が capability を再計算します。

- `inherit`: 最寄りの private ancestor まで、明示 grant と scope role を評価します。
- `private`: scope の暗黙 access を止め、明示 grant だけを評価します。
- private Document の作成者は永続化時に `manager` grant を明示的に持ちます。
- Project membership を失った user は、作成者であっても inherited Project Document を読めません。
- guest は明示 grant があっても viewer を上限とし、編集・コメント・共有を許可しません。
- archived Document は read / export と権限を持つ user の restore だけを許可します。
- expiring public link は read-only で、export は link 作成時に明示的に許可した場合だけ有効です。

System administrator の access は break-glass として private ancestor を含めて許可します。
通常の Workspace owner / admin は private ancestor を迂回しません。

Workspace search の Document hit は index 上の ACL field だけでは返しません。検索 response を
組み立てる直前に current Document を consistent read し、store の ACL を通過した hit だけを
`permissionVerified` として返します。Archive や permission 変更直後に projection が遅延しても
private content を漏らさない fail-closed の設計です。Projection は mutation で行い、一時障害や
既存 row の reconciliation は `search:backfill -- --source documents` で再投影します。Detail
polling は検索 table へ書き込みません。DynamoDB の projection row は本文 preview を 20,000 文字に
制限しますが、keyword 判定では ACL 検証済みの current Document から全文を memory 上で再構築するため、
Document 最大 payload の末尾まで検索対象になります。

## API

認証済み route:

- `GET|POST /api/documents`
- `GET /api/documents/recent`
- `GET|PATCH /api/documents/{documentId}`
- `POST /api/documents/{documentId}/operations`
- `POST /api/documents/{documentId}/archive`
- `POST /api/documents/{documentId}/restore`
- `POST /api/documents/{templateId}/instantiate`
- `GET /api/documents/{documentId}/versions`
- `POST /api/documents/{documentId}/versions/{versionId}/restore`
- `GET|POST /api/documents/{documentId}/comments`
- `POST /api/documents/{documentId}/comments/{commentId}/resolve`
- `GET|PUT /api/documents/{documentId}/presence`
- `DELETE /api/documents/{documentId}/presence/{clientId}`
- `PUT|DELETE /api/documents/{documentId}/favorite`
- `POST /api/documents/{documentId}/recent`
- `GET|POST|DELETE /api/documents/{documentId}/shares`
- `GET /api/documents/{documentId}/export`
- `GET /api/document-backlinks`（opaque cursor pagination）

Public link は `GET /api/public/documents/{token}` で解決します。Response は
`PublicDocumentResponse` へ投影し、kind、title、updatedAt、公開対象 content と export 可否だけを
返します。Permission/grant、relation、scope/tree、user ID、preference、内部 capability は
public response に含めません。Checklist の assignee と Whiteboard card の Work Item target も
公開用 content から除き、public JSON / Markdown / SVG export に同じ allowlist 投影を適用します。
Link で明示的に許可した場合だけ
`GET /api/public/documents/{token}/export` を利用できます。

Export は page / template の Markdown または JSON、whiteboard の SVG または JSON を返します。
SVG と埋め込み URL は server で検証・escape し、response は `no-store` にします。

## Web UX

Document 画面は global navigation の内側に Document tree、中央の editor / canvas、右側の
context panel を置きます。Tree は active / archive を最初の page だけ読み、明示的な「さらに
読み込む」で継続します。Recent は newest-first index から別に取得します。右 panel では
comment thread、強調表示した mention、backlink、activity / version を同じ文脈のまま確認でき、
各長大リストは opaque cursor で追加取得します。Work Item relation と Whiteboard card は
Team ID と Issue ID から `team/<teamId>/issue/<issueId>` を生成するため、逆リンクと画面遷移が
同じ canonical ID を使います。Whiteboard は canvas を広く保つため toolbar を floating control
にし、public share 画面では編集 control を表示しません。Mention 通知の deep link は対象 thread
を cursor 越しに取得し、対象 comment を drawer 内で強調・focus します。
