# Request form / intake queue

Issue #30 の request intake は、外部 requester が見る公開契約と、Workspace 内部の routing・権限・Work Item 変換を明確に分離する。

## Domain model

Request Form の root row は管理名、scope、draft、link、revision、現在の公開 version を保持する。draft の保存は公開済み response を変更しない。publish は次の version row を immutable snapshot として追加し、link が参照する version を進める。version row を更新・削除する API は提供しない。

Form definition は次を version とともに固定する。

- locale 別 title、description、confirmation message
- section と field の表示順
- text、email、URL、number、boolean、date、select、attachment field
- required、length、range、線形時間で評価できる制限付き pattern（完全 anchor、group / alternation / backreference / 可変 quantifier を禁止し、固定 `{n}` は1000以下）
- 先行 field の回答だけを参照する section/field conditional logic
- consent 文面と privacy URL
- attachment の件数、byte 数、MIME allowlist

Private routing snapshot は Team、Project、workflow status、assignee、priority、due-date offset、ordered condition、Work Item mapping を保持する。これは public DTO に含めない。Team scope の form は scope 外の Team へ route できない。

Submission は `formVersion` と immutable `formSnapshot` を保存する。管理画面は current draft ではなくこの snapshot で過去回答の field label、option、consent を表示する。workflow/custom field は publish 時と Work Item conversion 時の両方で current configuration に照合し、削除・変更済み参照は暗黙補完せず fail closed にする。

## Access boundary

Link mode は次の3種類である。

- `public`: capability URL を知る requester が anonymous submit できる。
- `auth-required`: active Workspace member の Cognito access token を要求する。
- `internal`: active Workspace member 専用 link として扱う。

Invalid、expired、revoked、archived link は同じ `RequestFormUnavailable` response を返す。public GET は `definition` と短命 one-time submission session だけを返し、Workspace ID、Team、Project、workflow、assignee、role、capability、rate-limit 設定を返さない。submit 成功 response も opaque receipt、confirmation、reply thread token だけである。

Form 管理、queue read、triage、attachment download は Workspace owner/admin に限定する。外部 thread token は追加情報 reply だけを許可し、任意の宛先、routing、status、assignee を指定できない。

## Storage and abuse controls

`RequestIntakeTable` は `scopeKey` / `recordKey` を primary key とし、TTL `expiresAt` と `RequestQueueIndex` を持つ。主な row は form、immutable version、hashed link/session/thread lookup、submission、upload、rate counter、duplicate pointer、email receipt である。

DynamoDB の 400 KB item 上限より十分小さく保つため、normalized form draft は128 KiB、回答全体は96 KiB、thread message history は64 KiB、submission root の event projection は32 KiB、保存 item は360 KiBを上限とする。Append-only event 本体は submission mutation と同じ transaction で immutable な別 row に保存し、detail / mutation response ではその event row を時系列に復元する。Queue response は一覧取得時の N+1 query を避けるため、submission root の bounded event projection を返す。件数上限だけでなく UTF-8 byte 数を server で検証し、超過時は DynamoDB へ書き込む前に `413 RequestPayloadTooLarge` を返す。

Public form GET は version と link digest に bind した短命 session を発行する。submit transaction は session を一度だけ consumeし、同じ fingerprint の response-loss retry だけ同じ receipt を返す。別 payload での再利用は `409` で拒否する。

Rate-limit key は trusted Lambda connection address だけを server secret で digest 化し、raw IP を保存しない。User-Agent や application header は rate identity に含めず、requester が client quota を任意に回避できないようにする。client と link/thread global の counter は別 namespace で、一つの DynamoDB transaction により条件付きで同時更新する。どちらかが上限なら両方を rollback し、無効 capability は counter row を作成しない。honeypot、minimum submit time、payload/field/attachment 上限も server で再検証する。

Duplicate detection は Workspace、form、normalized visible answers の keyed digest を利用し、候補 ID を提示する。自動的に terminal status へ遷移せず、admin の `mark-duplicate` action を必要とする。

## Attachment boundary

Request attachment は既存 private/versioned S3 bucket と GuardDuty Malware Protection を再利用する。API が生成した `workspaces/.../request-submissions/...` object key に対して、content type、size、server-side encryption、pending tag を固定した短命 PUT URL を発行する。

Submission session ごとに発行できる upload 件数と累積 byte 数を DynamoDB の atomic counter で form policy 以下に制限する。Consumed session は追加 upload を発行できない。Attachment ごとの one-time claim token は browser memory だけに保持し、server には HMAC digest だけを保存することで、submission session 更新後も raw token を response や回答へ永続化せず所有を照合する。Attachment ID は発行元 field と一対一で照合し、同じ ID の複数 field 利用を拒否する。GuardDuty scan が `available` になるまでは submission 自体を受理せず、clean 確認後にだけ pending lifecycle tag を解除する。

Submission は upload session と form field の対応、実 object size、immutable S3 version、scan status を検証する。内部 download URL は current scan tag が `available` の場合だけ発行し、clean 確認後に pending lifecycle tag を completed へ変更する。Object key と version ID は internal API response に含めない。

## Email ingestion

Email ingestion Lambda は通常 HTTP API と Function URL に公開しない。Provider/SES adapter は HTML、quoted reply、任意 header を除去した `RequestEmailEnvelope` を作り、timestamp と HMAC-SHA256 signature を付けて専用 Lambda を invoke する。

Email channel の abuse control は署名前の Provider/SES adapter 境界で実施する。Adapter は sender、reply thread、受信先ごとの rate limit と provider spam verdict を検証し、上限超過 event を署名または Lambda invoke しない。Lambda 内の Message-ID dedupe は再送の冪等性を保証するものであり、adapter の rate limit を代替しない。

Lambda は5分の replay window、constant-time signature、thread token、Message-ID dedupe、normalized sender と最初の email field の一致を検証する。Email 本文は plain text requester message としてだけ保存し、本文や subject から status/routing command を解釈しない。専用 function role は RequestIntakeTable 以外の business table を変更できない。

Email ingestion は既存 submission の reply thread 専用であり、宛先だけを知る任意 email から新規 submission は作成しない。初回 request は versioned form、必須回答、consent、attachment policy を public/shared API で検証する。`request-more-info` の staff message は requester thread に保存され、公開完了画面が capability token で thread を定期取得するため、同じ画面から追加情報を確認・返信できる。SMTP/notification provider への outbound 配信はこの境界の外である。

## Work Item conversion and trace

`convert` action は saved routing と operator override を組み合わせ、current Team directory、Project access、active assignee、workflow、custom field validation を再実行する。Work Item は `sourceRequestId` を保持する。

Work Item row、specialized event、generic audit event、configuration guards、submission の `converted` status と Work Item pointer は一つの `TransactWriteItems` で確定する。同じ request を retry した場合は `sourceRequestId` で既存 Work Item を返すため、response loss で二重 Work Item を作らない。Submission detail と Work Item の双方から source ID を追跡できる。

## API

Public/shared:

- `GET /api/request-intake/{token}`
- `POST /api/request-intake/{token}/uploads`
- `POST /api/request-intake/{token}/submissions`
- `GET /api/request-threads/{threadToken}`
- `POST /api/request-threads/{threadToken}/replies`

Workspace admin:

- `GET|POST /api/request-forms`
- `GET|PUT /api/request-forms/{formId}`
- `POST /api/request-forms/{formId}/publish`
- `GET /api/request-queue`
- `GET /api/request-submissions/{submissionId}`
- `POST /api/request-submissions/{submissionId}/actions`
- `POST /api/request-submissions/{submissionId}/attachments/{attachmentId}/access`

Triage action は `assign`、`request-more-info`、`reject`、`mark-duplicate`、`convert` の explicit union で、すべて `expectedRevision` を要求する。Terminal submission への追加 mutation は `409` で拒否する。
