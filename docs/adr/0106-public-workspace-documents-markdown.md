# 0106. Workspace の Document を Public API と MCP で Markdown として一覧・作成・更新し、scope は既存の `work-items:read` / `work-items:write` を使う

- 状態: 提案
- 日付: 2026-11-26
- 関連: Issue #708、#705、ADR 0025（置き換える）、ADR 0050

## 背景

ADR 0025 では、coding agent が仕様を読めるように、Work Item に link された Document だけを `work-items:read` で
読めるようにした。Workspace の Document を ID で直接読む endpoint は作らず、書き込みも扱わなかった。

Linear の MCP と同じ体験（#705）の段階 5 として、MCP から Document を一覧・取得し、Markdown で作成・更新し、
Work Item に link したい。Public API に Document の一覧・取得・作成・更新が要る。

Document は block（paragraph・heading・table・code・checklist・embed・diagram）で保存し、paragraph の本文は
Markdown として表示する。一方で Documents の operation は 1 回に 4 件までで、本文の全置き換えには使えない。
新しい scope（`documents:read` / `documents:write`）は、ADR 0025 と同じく Public API 互換性検査
（`ApiScope` enum の拡大を破壊的変更として拒否する）を通らない。

## 決定

- Public API に次の 4 つを足す。読み取りは `work-items:read`、書き込みは `work-items:write` で、書き込みは
  `Idempotency-Key` 必須。新しい scope は足さない。
  - `GET /api/v1/documents?projectId=&parentId=`: 閲覧できる Document を `{ id, kind, title, scope, parentId?, revision }`
    でページ取得する。archive 済みと、archive 済みフォルダーの下は除く。
  - `GET /api/v1/documents/{documentId}`: ページ・テンプレートの本文を `PublicDocumentContent`（Markdown）で返す。
  - `POST /api/v1/documents`: Markdown からページを作る。`projectId`・`parentId`・`workItem: { teamId, workItemId }`
    を任意で受け、`workItem` は Document 全体の relation として link する。
  - `PATCH /api/v1/documents/{documentId}`: `expectedRevision` を必須に、title の変更か本文の全置き換えをする。
- 権限は毎回 credential の持ち主として、Web の Documents と同じ判定で評価する。
  - 読み取りは Enterprise RBAC の `documents.read`（`documents.write` / `documents.manage` も可）。持たない持ち主には
    一覧が空、本文は `404` になる。閲覧できない Document と存在しない Document は同じ `404`。
  - 書き込みは `documents.write` か `documents.manage`。作成は Web の作成と同じ scope の判定（Project の member 以上、
    Workspace は guest 以外）、link 先の Work Item は Web の relation と同じ判定で、閲覧できないと失敗する。
    更新は Document の編集権限で、閲覧できなければ `404`、閲覧だけなら `403`。
  - 書き込みは Web と同じ authorization fence（member row の version、planning・enterprise・OrgUnit の revision）を
    transaction の条件に入れ、監査 event（`document.created` / `document.updated`）を同じ transaction に残す。
- Markdown は server で行を走査して block に変える。行頭の fenced code は code（`mermaid` は diagram）、記号を含まない
  ATX 見出しは heading、記号を含まない task list だけのまとまりは checklist、記号を含まない pipe table は table にする。
  それ以外（list、引用、link、参照定義と、その間の空行）は 1 つの paragraph Markdown にまとめる。paragraph は
  Markdown として表示されるので、見た目は変わらない。先頭にただ 1 つの `#` 見出しがあれば、export が title を書く
  場所なので本文から除き、`##` を見出し 1 にする。export した Markdown をそのまま書き戻しても見出しの階層は変わらない。
- 本文の置き換えは Documents store の新しい `replaceContent` で 1 revision として保存する。Document 全体の relation は
  残し、消えた block が持っていた relation は一緒に消す。version は通常の編集（`edit`）として残る。
- MCP の Workspace profile に `list_documents`（`issueId` を渡すとその Work Item に link された Document）、
  `get_document`、`save_document` を足す。`save_document` は読み取り専用の設定では出さない。MCP API revision を 6 に上げる。
- #708 の作業中に、新しい scope と既存 scope の案を並べて Shinji に判断を仰いだ（新 scope は互換性検査が落ちるため管理者マージが要る）。

## 検討した選択肢

- 選択肢 A: 新しい scope `documents:read` / `documents:write` を足す。利点: 同意画面で Document を別に許可できる。
  欠点: 互換性検査が数十件落ち、管理者マージか v2 が要る。
- 選択肢 B（採用）: 既存の `work-items:read` / `work-items:write` で扱う。利点: 互換性を壊さず、#409・#729 と同じ扱い。
  欠点: `work-items:*` の token が、持ち主の権限の範囲で Workspace の Document も読み書きできるようになる。
- 本文を block の JSON で受ける: 型は正確だが、agent が block 構造を組み立てる必要があり、Linear MCP の体験から遠い。
- 変換を Web の Markdown import と共有する: Web の import は workspace の境界をまたいで server から使えない。共有するには
  contracts に parser 依存の実装を持ち込むことになるため、server は行の走査だけの保守的な変換にした。

## 結果

- MCP から Document を作って Work Item に link でき、`list_documents` / `get_document` で読み直せる。
- `work-items:read` / `work-items:write` の意味が「Work Item と Workspace の Document」に広がる。`docs/public-api.md`、
  `docs/coding-agent-mcp.md`、利用者ガイド `docs/guide/coding-agent.md` にこの範囲を書く。
- 本文の置き換えでは block の ID が新しくなるため、block に付いたコメントは位置を失い、block が持つ link は消える。
  MCP の guide で、頼まれたときだけ本文を置き換えるよう案内する。
- Document の読み書きを Work Item と別に同意させたい要望が出たら、Public API v2 か、互換性検査に scope 追加の例外を
  設ける ADR を書いて、この判断を置き換える。
