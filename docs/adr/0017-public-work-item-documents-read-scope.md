# 0017. Work Item に link された Document を `work-items:read` で Work Item 経由だけ読ませる

- 状態: 提案
- 日付: 2026-11-20
- 関連: Issue #409, PR #606

## 背景

coding agent が MCP から、作業中の Work Item に関係する仕様 Document を読めるようにしたい。
MCP server は Public API を API key / OAuth token で呼ぶので、Document の読み取りにも
Public API の scope が要る。

素直に作ると `documents:read` のような新しい scope になる。しかし Public API の互換性検査
（`scripts/check-public-api-contract.ts`）は response の enum 拡大を破壊的変更として拒否する。
`ApiScope` は API key・OAuth app・webhook・personal key の response に出るので、scope を 1 つ
足すだけで数十件の違反になり、OAuth2 securityScheme の scopes 追加も security contract の
違反になる。v1 の互換性を保ったまま新 scope を足す仕組みは今はない。

## 決定

- 新しい scope は足さない。Work Item に link された Document は、既存の `work-items:read` で
  次の 2 つの endpoint からだけ読める。
  - `GET /api/v1/work-items/{workItemId}/documents?teamId=…`: その Work Item に link された
    Document の ID と title の一覧。
  - `GET /api/v1/work-items/{workItemId}/documents/{documentId}?teamId=…`: page / template の
    本文を Markdown で返す。
- 読めるのは「指定した Work Item を relation の target に持つ Document」だけで、Workspace の
  Document を ID で直接読む endpoint は作らない。
- 権限は、毎回の読み取りで credential の持ち主（API key の作成者、OAuth の承認者）として
  評価する。
  - Work Item は `work-items.read` と Project の viewer 以上で見えること。
  - Document は Enterprise RBAC の `documents.read`（`documents.write` / `documents.manage` でも可）
    と、Web の Documents と同じ Document ごとの権限・Enterprise scope の境界で見えること。
  - 見えない Document、link されていない Document は、存在を伏せて 404 にする。
- 返す本文は利用者が書いたデータとして扱い、MCP の guide でも指示として読まないよう明記する。
- PR #606 の作業中に、新 scope を足す案と既存 scope で範囲を絞る案を並べ、Shinji が後者を選んだ。

## 検討した選択肢

- 選択肢 A: 新しい scope `documents:read` を足す。利点: 同意画面で Document の読み取りを
  別に許可・拒否できる。欠点: v1 の互換性検査が落ち、v2 か互換性の例外の仕組みが要る。
- 選択肢 B（採用）: `work-items:read` で Work Item 経由だけ読ませる。利点: 互換性を壊さず、
  読める範囲が「Work Item に link された Document」に限られる。欠点: `work-items:read` を
  既に持つ credential が、追加の同意なしに link 済み Document の title と本文を読めるようになる。
  ただし持ち主が Web で読める Document に限られ、持ち主の権限を超えることはない。

## 結果

- coding agent は追加の設定なしで、Work Item の仕様 Document を MCP の `list_task_documents` /
  `read_document` と `get_task` の `relatedDocuments` から読める。
- `work-items:read` の意味が「Work Item と、それに link された Document」に広がる。
  `docs/public-api.md` と `docs/coding-agent-mcp.md`、利用者ガイド `docs/guide/coding-agent.md`
  にこの範囲を書く。
- Document の読み取りを Work Item と別に同意させたい要望が出たら、Public API v2 か、
  互換性検査に scope 追加の例外を設ける ADR を書いて、この判断を置き換える。
