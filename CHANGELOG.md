# Changelog

Mukuroji が配布する coding agent MCP（`mcp.mjs`）と、MCP が使う server API の変更を記録します。
形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に、MCP の version は
[Semantic Versioning](https://semver.org/lang/ja/) に従います。
アプリ（Web・API）全体には version 番号を付けず、deploy した commit SHA を version とします。
アプリの変更履歴は deploy ごとの job summary にある比較 link で辿ります（[ADR 0057](docs/adr/0057-app-version-is-deployed-commit.md)）。

## 記録のしかた

- MCP の tool、引数、結果、または MCP が呼ぶ Public API を変えた PR は、`## [Unreleased]` に
  `Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security` のどれかで1行ずつ書きます。
- server API の破壊的変更と非推奨は、MCP の変更がなくても必ず書きます。
- 新しい MCP build が新しい server API を必要とするときは
  `contracts/src/coding-agent-mcp.ts` の `CODING_AGENT_MCP_API_REVISION` を上げ、
  古い MCP を server が受け付けなくなるときは `CODING_AGENT_MCP_MINIMUM_API_REVISION` を上げます。
  どちらも変えたことをこのファイルに書きます。
- Release するときは `server/src/modules/coding-agent-mcp/application/compatibility.ts` の
  `CODING_AGENT_MCP_VERSION` を上げ、`## [Unreleased]` の内容を `## [<version>] - <YYYY-MM-DD>` に移します。
  tag `mcp-v<version>` の Release note は、この section から作られます
  （`bun run mcp:release-notes -- --tag mcp-v<version>`）。

## [Unreleased]

### Added

- server API: `GET /api/v1/agent-context` が `acceptNewRuns` を返します。Team の管理者が新しい Agent Run の受付を
  止めている間は `false` で、start・resume・take over は `409 not_ready`（pointer `/acceptNewRuns`）になります（#412）。
- MCP: `get_configuration` の `agentSettings.acceptNewRuns` で受付停止を示し、`get_next_task` は受付停止中に
  新しいタスクや再開を提示せず `action: none` と `acceptingNewRuns: false` を返します。古い server では常に `true` です（#412）。
- server API: `GET /api/v1/work-items/{workItemId}/agent-run-questions?teamId=` を追加しました。Work Item の
  `blocker`・`handoff` report を新しい順に最大 20 件、人の回答（`answer`）付きで返します。scope は既存の
  `work-items:read` です。質問は新しい `AgentRunQuestion` で返し、既存の `AgentRunReport` は変えていません（#411）。
- MCP: `get_task` が `questions` で、タスクの `blocker`・`handoff` 報告と人の回答を返します。server が古いとき、
  読み取りが拒否されたときは `null` です（#411）。
- server API: `GET /api/v1/work-items/{workItemId}/attachments` と `.../attachments/{fileId}/download` を追加しました。
  閲覧できて最新の版がマルウェア検査を通った添付ファイルの一覧と、その版の短期 download URL を返します。
  scope は既存の `work-items:read` で、download は監査ログに残ります（#409）。
- MCP: `get_task` が download できる添付ファイルを `attachments` で返し、`list_task_attachments` と
  `get_attachment_download_url` を追加しました。どちらも読み取り専用で、`MUKUROJI_MCP_READ_ONLY=true` でも使えます。
  古い server では `attachments` が `null`、ツールは `unsupported` です（#409）。
- `MUKUROJI_MCP_TEAM_IDS` で複数の Team を1つの MCP 設定で扱えるようにしました。`get_configuration` は `teams` を、`get_next_task` は `teamId` を返し、`create_task` は `teamId` を受け取ります。Team が1つの設定は従来どおりです（#410）。
- server API: `GET /api/v1/projects/{projectId}/charter?teamId=` を追加しました。Web の charter パネルと同じ
  ライフサイクル状態・コード・説明・目的・責任者・スポンサー・計画期間・タグ・関連リポジトリ URL を返します。
  scope は既存の `work-items:read` で、Project の viewer 以上が読めます（#638）。
- MCP: `get_configuration` が、設定した Project の charter を `projectCharter` で返します。Project を設定して
  いないとき、server が古いとき、charter の読み取りだけが拒否されたときは `null` です。所有者が Project を
  閲覧できないときは、catalog と同じく `get_configuration` 全体がエラーになります（#638）。
- server API: `POST /api/v1/agent-telemetry/v1/logs` を追加しました。Claude Code の OpenTelemetry logs
  （OTLP/HTTP JSON）からトークン数と推定費用を受け取り、同じ instance の Run に時刻で割り当てます。scope は既存の
  `work-items:write` で、今の本人用 token のまま送れます（ADR 0061）。MCP の変更はありません。
- Web: Factory board の期間サマリーに、期間内に終わった Run のトークン使用量（合計・Project 別・上位のタスク）を
  表示します。推定費用は Team manager にだけ表示します。agent を接続の画面で Claude Code に instance ID を入力すると、
  トークン使用量を送る設定も作ります。
- `get_task` が、タスクに link された Document のうち credential 所有者が閲覧できるものの最初の 1 ページを
  `relatedDocuments` で返します。古い server と、所有者が Document を読めない場合は `null` です。
- 読み取りツール `list_task_documents`（link された Document の一覧）と `read_document`（ページ・テンプレートの
  本文を Markdown で読む）を追加しました。read-only 設定でも使えます。
- server API: `GET /api/v1/work-items/{workItemId}/documents` と
  `GET /api/v1/work-items/{workItemId}/documents/{documentId}` を追加しました。scope は `work-items:read` で、
  Document の閲覧権限は request ごとに credential 所有者の権限で評価します。
- server API: `POST /api/v1/work-items` の `schedule` を省略できるようにし、`dueDate` を追加しました。`schedule` を
  省略すると server が Workspace の稼働カレンダー（稼働曜日・会社の休日・日本の祝日）を付けます。
- Workspace profile（`MUKUROJI_MCP_PROFILE=workspace`）を追加しました。`MUKUROJI_MCP_URL` と `MUKUROJI_MCP_TOKEN` だけで起動し、
  Team を固定せずに `whoami`、`list_teams`、`list_projects`、`list_users`、`list_issue_statuses`、`list_issues`、
  `get_issue`、`list_comments` の読み取りツールを公開します。`get_issue` と `list_comments` は `ABC-123` 形式の key だけで
  Work Item を指せます。既定の profile（`tasks`）のツールと設定は変わりません。
- Workspace profile に書き込みのツール `save_issue`（`id` なしで作成、`id` ありで更新）と `save_comment` を追加しました。
  更新には `expectedRevision`、書き込みには UUID の `idempotencyKey` が要ります。`MUKUROJI_MCP_READ_ONLY=true` で外せます。
- server API: `GET /api/v1/me`、`GET /api/v1/teams`、`GET /api/v1/projects/{projectId}/members`、
  `GET /api/v1/work-item-keys/{key}` を追加しました。scope は `work-items:read` で、request ごとに credential 所有者の
  現在の権限で評価します。読めない Work Item の key は、存在しない key と同じ 404 です。

### Changed

- server API: `GET /api/v1/agent-context` の `brief` は、Team に自分の brief がないとき Workspace の既定 brief を返します。
  Team が Agent settings を保存していないときの `requireAcceptanceCriteria` と、`GET /api/v1/agent-settings` の
  `leaseMinutes`・`allowTakeoverAfterLeaseExpiry` は Workspace の既定値です。MCP と応答の形は変わりません（#412）。
- MCP API revision を 2 に上げました。server は revision 1〜2 を受け付けます。revision 1 の server に
  接続した新しい MCP は server が古いと警告し、Document を読むツールは使えません。
- `create_task` が `schedule` を送らず、Workspace の稼働カレンダーで Work Item を作るようにしました。
  MCP API revision を 3 に上げ、server は revision 1〜3 を受け付けます。revision 2 以前の server に接続した新しい MCP は
  server が古いと警告し、`create_task` は失敗します。
- MCP API revision を 4 に上げました。server は revision 1〜4 を受け付けます。revision 3 以前の server に接続した新しい MCP は
  server が古いと警告し、Workspace profile のツールは使えません。
- server API: Software factory が off の deploy でも、本人用 token の確認・発行・再発行
  （`/api/developer/me/agent-connection`、`POST /api/developer/me/api-keys`、`.../rotate`）と、管理者による本人用 token の
  rotate を `503` で断らないようにしました。Web の「agent を接続」は off では Workspace profile の設定例を出します。
- server API / MCP: `GET /api/v1/work-items/{workItemId}/documents/{documentId}` と `read_document` が返す Markdown で、
  段落の text を escape せずに Markdown のまま返すようにしました。raw HTML の部分だけを escape し、参照の定義を使う
  link と画像は inline の link に書き換えて定義を消し、脚注の label は `<block の番号>-<番号>` に付け替えます。
  定義のない `[^…]` は `[\^…]` と書き、隣の block とつながる段落の間には何も表示しない定義
  `[mukuroji-block-boundary]: #` を入れます。参照の書き換えで増える長さが 1 回で 1,000,000 文字を超える
  段落は、書き換えずに平文で書きます。見出し・チェック項目・表の cell・埋め込みのタイトルは、`&` と `~` と
  見出し末尾の `#` も escape して書いた文字のとおりに表示されるようにし、チェック項目と表の cell の中の
  ページへの link（`[label](/documents/<id>)`）は escape せず Markdown の link として書きます。
  response の形と field は変わりません（#422）。

### Fixed

- server API: Workspace ID に `#` を含む環境（deploy の既定値 `workspace#production`、Floci の
  `workspace#mukuroji-local`）で、**agent を接続** の表示と自分用 token の発行・認証が 400 で失敗していました。

## [1.0.0]

最初の versioned release です。MCP API revision 1 を使います。

### Added

- `node mcp.mjs --version` で MCP の version を表示します。起動時には version と MCP API revision を stderr に出します。
- MCP の `serverInfo.version` と `get_configuration` の `mcp` に、MCP の version、MCP API revision、server との互換性を返します。
- server の `GET /api/health` が、受け付ける MCP API revision の範囲を `codingAgentMcp` で返します。
  MCP は起動時にこれを読み、範囲外または読めないときに警告します。
- `bun run mcp:build` が `mcp.mjs.sha256` も生成します。
