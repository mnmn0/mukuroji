# Document・Wiki・Whiteboard

Document 機能は page、folder、template、whiteboard を同じ tree と権限モデルで扱います。
Canonical schema は `@mukuroji/contracts`、access policy は
`server/src/modules/documents/domain/document-access.ts`、永続化と認可は
`server/src/modules/documents/adapter-out/dynamodb/dynamo-db-documents-client.ts`、
HTTP route は `server/src/modules/documents/adapter-in/http/document-api.ts` にあります。

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
Batch は DynamoDB transaction と backlink 更新を常に atomic に収めるため最大 4 operation です
（`DOCUMENT_OPERATION_BATCH_LIMIT`）。

- 別 element の更新は stale な `baseRevision` からでも現在 snapshot へ merge します。
- 同じ element が更新済みの場合は batch 全体を `409 DocumentOperationConflict` で拒否します。
- 同じ `operationId` と同じ内容の再送は二重適用しません。
- 同じ `operationId` を異なる内容で使うと idempotency conflict にします。
- 確定した mutation ごとに immutable version snapshot を保存します。
- Restore は過去 snapshot を上書きせず、新しい revision として保存します。
- Restore が再導入する relation / Whiteboard Work Item target は current source of truth で
  再認可し、権限を失った target を過去 snapshot から復活させません。

### 履歴の保持期間と名前付き version

自動保存の version（metadata、delta、snapshot）は作成から **180 日** で DynamoDB TTL により
削除されます（`DOCUMENT_VERSION_RETENTION_DAYS`。full snapshot は delta を復元する base として
さらに 1 日長く残します）。保持期間を過ぎた version は履歴・preview・復元に出ません。
Operation receipt は 30 日です。保持期間は現在 Workspace ごとには変えられません。

名前を付けて固定した version（例: 「v1.0 承認版」）は保持期間の対象外です。固定すると
metadata row の `expiresAtEpoch` を外し、その revision の full snapshot を TTL なしで書きます。
後続の delta が期限切れで消えても、固定した version は単独の snapshot から preview・比較・復元
できます。固定には Document の編集権限が要り、名前は 1〜120 文字です。同じ version を再度固定
すると名前を付け替えます。

### Version の承認

固定した version は承認の対象（`ApprovalRequest.subjectType: 'document-version'`）にできます。
承認依頼は成果物として link する Work Item に作り、file version の承認と同じ approval row、
reviewer の Inbox、判断と取消、Work Item の承認集計（完了 Gate を含む）を使います。
依頼には Document の編集権限（固定と同じ。Enterprise role では `documents.write` 以上）、その
version が固定済みであること、Work Item の編集権限と Enterprise role の `files.approve` が要り、
reviewer は Work Item を閲覧できる active member に限ります（guest は reviewer にできません）。
Document 側の表示用に、file proofing table の `WORKSPACE#<workspaceId>#DOCUMENT#<documentId>`
partition へ `APPROVAL#<createdAt>#<approvalId>` の pointer row を書き、承認一覧はそこから main
approval row を読み、閲覧者が Work Item を見られる承認だけを返します。
Work Item 側の認可は Document の route の scope ではなく、その Work Item の route
（依頼は `POST /api/teams/{teamId}/issues/{issueId}/approvals`、一覧は Work Item ごとに
`GET /api/teams/{teamId}/issues/{issueId}/files`）として Enterprise permission を評価します。
そのため Document の権限を Project A、Work Item の権限を Project B で持つ member も依頼でき、
B の承認も一覧に出ます。

### Link の上限

1 つの Document は relation と Whiteboard の Work Item object を合わせて最大 500 件の link を
持てます（`DOCUMENT_MAX_BACKLINK_COUNT`）。Backlink row と Work Item 削除 fence は、link を
追加・削除した Document の更新と同じ DynamoDB transaction で書くため、Document と backlink が
食い違ったまま残ることはなく、Work Item 側の関連 Document にも即時に表示されます。

Transaction は 100 action までなので、1 回の更新で追加・削除できる link は最大 28 件です
（`DOCUMENT_MAX_BACKLINK_CHANGE_COUNT`）。通常の編集は 1 batch 4 operation なので常に収まります。
block や Whiteboard object を削除するとその要素が持つ link も消えるため、1 つの要素が持てる
link は 7 件までです（`DOCUMENT_MAX_ELEMENT_LINK_COUNT`、Work Item card 自身の link を含む）。
4 要素を一度に削除しても 28 件に収まります。この上限より前に保存された要素は 8 件以上の link を
持っていても編集でき、link を減らすこともできます。拒否されるのは上限を超えた要素に link を
増やす変更だけです。超えるのは、28 件を超える Work Item object を含む
Whiteboard の作成と、28 件を超える link の差分を持つ version への restore で、どちらも何も書かずに
`413 DocumentBacklinkChangeLimitExceeded` を返します。その場合は少ない link で作成してから
追加するか、新しい version から段階的に戻します。

`POST /api/document-backlinks/batch` は最大 500 target を受け付け、1 request で読む backlink は
14 件までです。読み切れなかった target は `pending` に入れて返し、client が続きを要求します。

Presence は user / Document ごとに一つの置換可能な短い lease として保存します。画面は
heartbeat を送り、期限切れ collaborator を表示しません。

画面は `POST /api/documents/{documentId}/realtime/tickets` で ticket を取り、既存の WebSocket に
Document の scope で接続します。ticket は `canView` を満たす member にだけ発行し、subscription は
5 分で失効します（client が失効前に接続し直し、接続中は 30 秒ごとに ping を送ります）。本文・comment・presence・share が変わると API が
`document.changed` の signal（Document ID と変わった部分だけ）を送り、client は HTTP API で取り直します。
presence の heartbeat は、参加直後と selection が変わったとき（`announce: true`）だけ signal を送ります。
接続中の再取得は 60 秒ごとで、WebSocket がない環境や接続断では本文 3.5 秒・comment と presence 4 秒の
polling に戻ります。ADR 0041 を参照してください。一覧は評価件数と返却件数を
制限し、任意の `clientId` を大量に作ることで他 user を押し出せない構造です。

Comment は root / reply、block・text・whiteboard object anchor を保持します。解決済み root
への reply は、reply 保存 transaction 内でも root の未解決状態を condition check して拒否します。
Mention は active Workspace member を検証し、comment と同じ transaction で audit event を保存
します。Reply の通知は mention された member に加え、thread の root の作成者とそれまでの返信者
（reply 作成者自身を除く）にも届きます。参加者は thread ごとの index row
（`COMMENT_PARTICIPANT#<documentId>#<rootCommentId>#<memberKey>`）に comment と同じ transaction で
書き、返信時はその thread の row だけを全 page 読みます。index ができる前の thread（root 作成者の
row がない）は Document の comment row を全 page 読んで参加者を集め、25 人以下なら同じ返信の
transaction で index に書き足します。どちらも page を途中で打ち切りません。Comment の作成者は自分の
comment の本文と mention を編集（`editedAt` を記録し、新しく mention された member にだけ通知）
し、削除できます。削除は row を消さず、本文と mention を空にして `deletedAt` を記録するので、
thread の返信はそのまま残り、画面は「このコメントは削除されました」と表示します。編集と削除の
`Idempotency-Key` は Workspace・member・key の hash を sort key にした
`COMMENT_MUTATION#<documentId>#<hash>` の receipt（operation・comment・入力の fingerprint と
結果の comment を持ち、30 日の TTL）に、変更と同じ transaction で記録します。同じ key の
再送は comment を書き換えずに最初の結果を返し（その後の新しい編集を巻き戻さない）、同じ key で
別の操作・comment・入力を送ると `409 DocumentCommentIdempotencyConflict` を返します。通知一覧を返す直前にも current Document ACL を再評価するため、通知作成後に private
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
- `GET /api/documents/{documentId}/versions/{versionId}`（read-only snapshot）
- `POST /api/documents/{documentId}/versions/{versionId}/pin`
- `POST /api/documents/{documentId}/versions/{versionId}/restore`
- `POST /api/documents/{documentId}/versions/{versionId}/approvals`
- `GET /api/documents/{documentId}/approvals`
- `GET|POST /api/documents/{documentId}/comments`
- `PATCH|DELETE /api/documents/{documentId}/comments/{commentId}`（作成者だけ）
- `POST /api/documents/{documentId}/comments/{commentId}/resolve`
- `GET|PUT /api/documents/{documentId}/presence`
- `DELETE /api/documents/{documentId}/presence/{clientId}`
- `POST /api/documents/{documentId}/realtime/tickets`
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
comment thread、強調表示した mention（composer で `@` に続けて名前を入力し候補から選ぶ。`@member-key` と打っても認識する）、backlink、activity / version を同じ文脈のまま確認でき、
各長大リストは opaque cursor で追加取得します。Work Item relation と Whiteboard card は
Team ID と Issue ID から `team/<teamId>/issue/<issueId>` を生成するため、逆リンクと画面遷移が
同じ canonical ID を使います。Whiteboard は canvas を広く保つため toolbar を floating control
にし、public share 画面では編集 control を表示しません。Mention 通知の deep link は対象 thread
を cursor 越しに取得し、対象 comment を drawer 内で強調・focus します。

Paragraph block は Markdown として表示します（GFM の箇条書き・番号付きリスト・link・強調・
引用・表・inline code。単独の改行もそのまま改行として表示）。描画は Work Item のコメントと共通の
sanitize 済み renderer（`web/src/shared/ui/SafeMarkdown.tsx`）で、raw HTML は実行せず文字として
表示し、外部 URL の画像は読み込みません。Work Item key の link と `attachment:` 添付はコメント
だけの機能で、paragraph では文字のまま表示します。
Editor 右上の「プレビュー」で編集中のページを表示どおりに確認できます。Block は各 block の
「+」から直下に挿入でき、table は行と列を個別に削除できます（列は 1 つ以上残します）。
Diagram block の `text` 形式は `A → B` の流れとして描画します。Mermaid の描画 library は同梱して
いないため、新しい diagram では Mermaid を選べず、取り込み済みの Mermaid は source として表示します。

まだないもの: 画像・file の block と Document への file 添付（file の保存・malware scan・認可は
Team の Work Item / Project 単位の scope で作られており、Workspace 直下の Document を添付先に
するには scope・保存 key・整合性検査の設計が別に要るため）、Work Item 一覧を埋め込む block、
Document の watch。

「共有とアクセス」のメンバー追加は、Workspace の active member を名前で選べます（member key や
メールの直接入力もできます）。共有済みの一覧とコメントの作成者は表示名で表示します。

右 panel の version 一覧では各 version の「確認・比較・承認」から dialog を開き、read-only の
preview、別の version または現在の内容との block 単位の差分（追加・削除・変更・移動）、
名前を付けた固定、Work Item への承認依頼と結果の確認ができます。Work Item の承認一覧の
「Document の版を開く」は `/documents/{documentId}?context=versions&versionId=...` で同じ dialog
を開きます。

### Markdown の取り込み

Documents home の「Markdown を取り込む」で、貼り付けた Markdown または Markdown ファイル 1 つ
（300 KB まで）から新しいページを作れます。変換は Web で行い、結果は通常のページ作成 API で
保存するので、server 側の検証・権限・block 上限（500 block、表は 50 列・200 行、1 block 5 万文字）が
そのまま適用されます。上限を超える Markdown は作成前に理由を表示します。

- `#` 〜 `######` の見出しは heading block に変換します。先頭にある唯一の `#` 見出しはページの
  タイトルにし、`##` を level 1 として level 3 までに詰めます（ページの Markdown export と同じ形
  なので、export したページは見出しの level を保ったまま戻せます）。それ以外は最も浅い見出しを
  level 1 にし、タイトルはファイル名（なければ「取り込んだページ」）にします。
- ページの Markdown export は表の各行の間に空行を入れるので、その形の表も table block に戻します。
- フェンス付きコードは code block（安全な言語名だけ保持）、`mermaid` のフェンスは diagram block、
  `- [ ]` / `- [x]` の連続行は checklist block、GFM のパイプ表は table block にします。
- 段落・リスト・引用・リンク・画像・HTML は、backslash escape も含めて Markdown のまま paragraph
  block の text として残します。paragraph は Markdown として表示するので、リスト・引用・リンクは
  描画され、`\*literal\*` のような escape は文字のまま、HTML は文字のまま表示されます。画像は
  描画しません。Markdown 書き出しは paragraph の text を Markdown のまま書き、raw HTML の開始
  `<` だけを escape します（引用の `>`、autolink、code span と fenced code の中身はそのまま）。
  そのため書き出したページを取り込み直しても段落の表示は変わりません。この変更より前に取り込んだ段落は escape を外して保存
  しているため、`*` などを含むと強調として表示されることがあります。
- folder 単位の一括取り込みと、相対リンクを取り込んだページ同士のリンクに変換する処理はまだありません。

### 同梱テンプレートと宿題の Work Item 化

Documents home の「同梱テンプレート」から、議事録・設計書・振り返り（KPT）のページを作れます。
テンプレートは Web に同梱しており、Workspace ごとの保存や初期化は不要です。作成時に今日の日付、
選んだ Project の名前、入力した参加者をタイトルと本文に差し込み、Project を選んだ場合はその
Project scope にページを作ります。

編集中の checklist 項目には「Work Item にする」が出ます。Project・担当者・期限（任意）を選ぶと
Work Item を作り、その checklist block を起点にした Work Item relation を
`checklist-item:<blockId>:<itemId>` の ID で保存します。作成済みの項目には「Work Item を開く」が
出て、Work Item 側の関連ドキュメントからは元のページへ戻れます。Work Item の作成後にリンクだけが
失敗した場合は、同じ画面で再実行するとリンクだけをやり直します。Team に backlog 区分の status があれば、
Work Item はクイック作成と同じく backlog に仮保存するので、必須カスタムフィールドは後から入力できます。
リンク済みの項目は編集権限のない閲覧者にも「Work Item を開く」として表示します。
ダイアログを開いている間に別の編集で同じ項目がリンクされた場合は、そのリンクを置き換えずに作成を止めます。

Whiteboard の付箋（note object）も同じダイアログで Work Item にできます。付箋を選ぶと inspector に
「Work Item にする」が出て、付箋の文字列を初期タイトルにします。Relation は付箋の object を起点にし、
`whiteboard-note:<objectId>` の ID で保存します（Work Item card の `system:whiteboard-work-item:` とは別の
namespace）。作成済みの付箋には「Work Item を開く」が出て、Work Item 側の関連ドキュメントから元の
Whiteboard へ戻れます。付箋を削除すると server が relation も一緒に消します。付箋は配置したまま残し、
Work Item card への置き換えはしません。

こうして作った Work Item を完了にすると、元のチェック項目は `checked: true`、付箋は `done: true` に
なります。Work Item の更新で audit outbox に入る `work-item.updated`（`completionTransition`）を
automation event worker が受け、上の 2 種類の relation を持つ要素だけを system actor
（`system:work-item-completion`）で書き換えます（ADR 0053）。完了させた人の Document 権限は問わず、
archive 済みの Document と、手で張った link・Work Item card は対象外です。Work Item を再オープンしても
チェックは外しません。付箋の完了は inspector の「完了」でも切り替えられます。

