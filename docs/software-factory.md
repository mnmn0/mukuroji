# Software factory: ローカル coding agent の Run と Factory board

## 目的と境界

この文書は、mukuroji を Software factory として運用するための正本契約を定義する。
Software factory とは、要求が Work Item として入ってから、Ready 判定、実装、レビュー、
完了までが mukuroji 上の状態として流れ、開発者の手元で動く coding agent（Claude Code、
Codex、Kiro など）が [Coding Agent MCP](coding-agent-mcp.md) を通じて参加し、人は判断点だけに
介在し、作業の証拠が mukuroji に残る状態を指す。

Phase 1 の範囲は次の 5 つである。

1. Agent Run: agent process による Work Item の claim を表す entity と lease
2. 構造化された進捗報告: 検証結果と成果物 link を機械可読に保存する report
3. 仕様と context: 受け入れ条件と Project ごとの agent brief
4. Definition of Ready: agent が着手してよい Work Item の判定
5. Factory board: Run を人の判断単位で並べる Web 画面

次は Phase 1 の非目標とし、方向だけを「後続 Phase」に記す。

- mukuroji が agent process を起動・停止・再起動すること。接続は pull 型だけである。
- lease 切れを理由にした自動再配車、自動完了、自動 cancel。停滞は人が判断する。
- agent の成果物（PR、CI、レビュー結果）を mukuroji 自身が外部 provider から検証する Gate。
  Phase 1 は agent の自己申告を保存し、GitHub adapter 実装後に検証を重ねる。
- Run の token / 費用の集計と stage 別 lead time。

## 前提

- 接続は既存の stdio MCP とし、MCP process は public API client として動作する。
  AWS credential や DynamoDB への直接アクセスは引き続き不要である。
- MCP client（Claude Code、Codex、Kiro）が共通に依存できるのは tools だけとみなす。
  resources と prompts の対応度は client ごとに異なるため、agent が判断に必要とする情報は
  tool の戻り値に含め、resources は補助とする。
- 同じ Workspace member が複数の runtime を同時に使う。各 agent は同じ `ASSIGNEE_ID` と
  同じ credential で接続しうる。
- process の生死は mukuroji から観測できない。laptop の closed、network 切断、client の
  強制終了は通知されない。
- Work Item の責任者（`assigneeUserId`）は引き続き人間の Workspace member とする。
  agent の runtime と instance は Run に記録し、machine ごとの agent member は作らない。

## 用語

| 用語 | 定義 |
| --- | --- |
| Agent Run | 1 つの agent instance が 1 つの Work Item に対して持つ claim。開始から終了または解放までの区間。 |
| Runtime | agent を動かす client 種別。`claude-code`、`codex`、`kiro`、`other`。 |
| Instance | 同じ credential・同じ assignee の下で agent を区別する安定 ID。machine と runtime ごとに決まる。 |
| Lease | Run が有効とみなされる期限。agent の mutation または heartbeat で延長する。 |
| 停滞（stalled） | lease が切れた `active` Run。保存された状態遷移ではなく read 時に導出する。 |
| Ready | agent が新規に着手してよい Work Item の状態。Team の Agent settings が指す workflow status で表す。 |
| 受け入れ条件 | Work Item が完了とみなされる条件の構造化 list。 |
| Agent brief | Team / Project ごとに agent へ渡す作業前提（repository、規約、検証コマンド、関連 Document）。 |
| Factory board | Team の Run を処理中・判断待ち・停滞・失敗・完了の lane で並べる Web 画面。 |

## Agent Run

### Entity

| Field | Required | Description |
| --- | --- | --- |
| `schemaVersion` | yes | Agent Run contract の schema version。初期値は `1`。 |
| `runId` | yes | `run_` + UUID。server が採番する。 |
| `directoryId` / `directoryTeamId` / `teamId` | yes | Work Item と同じ tenancy key。 |
| `workItemId` | yes | claim 対象の Work Item ID。 |
| `assigneeUserId` | yes | Run 開始時の Work Item 責任者。credential の actor と一致することを server が検証する。 |
| `runtime` | yes | `claude-code`、`codex`、`kiro`、`other`。 |
| `agentName` | yes | 表示用 agent 名。既存 `MUKUROJI_MCP_AGENT_NAME` と同じ制約（最大 64 文字）。 |
| `instanceId` | yes | client が送る opaque な安定 ID の SHA-256 hash。raw 値は保存しない。 |
| `credentialId` | yes | Run を開始した API key / OAuth app の公開 ID。監査用。 |
| `state` | yes | `active` または `finished`。 |
| `outcome` | no | `finished` の理由。`completed`、`paused`、`failed`、`released`、`superseded`。 |
| `startRevision` | yes | claim と同時に適用した Work Item revision。 |
| `startedAt` / `lastHeartbeatAt` / `leaseExpiresAt` | yes | UTC ISO 8601。`leaseExpiresAt = lastHeartbeatAt + leaseMinutes`。 |
| `finishedAt` | no | `finished` になった時刻。 |
| `finishedBy` | no | `agent` または解放した member の公開 ID。 |
| `reportCount` | yes | 保存済み report 数。`0` から単調増加。 |
| `lastReportSummary` | no | 最新 report の種別と先頭 256 文字。board の tile 表示用 projection。 |

Run は 1 つの Work Item に対して同時に 1 つだけ `active` になれる。これは「同じ assignee の
別 instance が、他方の作業中 Work Item を誤って操作しない」ための fence であり、同じ
credential を共有する agent 同士を敵対的に隔離するものではない。`instanceId` は client
申告値であり、同じ credential の trust boundary 内での識別に限る。

### 状態

```text
(なし) --start--> active --finish(completed|paused|failed)--> finished
                 active --release(人)-------------------------> finished(released)
                 active --take over(別 instance, 設定で許可時)--> finished(superseded) + 新 active
```

- `active` かつ `leaseExpiresAt < now` を停滞として read 時に導出する。停滞は `state` を変えず、
  scheduler も動かさない。停滞 Run も fence として有効であり、人の解放か、設定で許可された
  take over だけが次の Run を開始できる。
- `paused` は agent が自分の意思で作業を中断した終了（レビュー待ちへ移動、blocker で停止、
  ユーザーからの指示）である。Work Item の workflow status は別途 `move_task` で変える。
- `failed` は agent が完了できないと判断した終了である。Work Item の status は変えない。
- `completed` は `complete_task` 成功後に agent が Run を閉じた終了である。Run の終了は
  Work Item の完了を意味せず、その逆も成り立たない。

### Lease

- lease の長さは Team の Agent settings `leaseMinutes`（既定 30、範囲 5〜240）で決める。
  Run の開始時に当時の値を `leaseMinutes` として固定し、設定変更は新しい Run から効く。
- Run 配下の mutation（report、finish、`agentRunId` 付き Work Item 更新）と `heartbeat` は
  同じ transaction で `lastHeartbeatAt` を更新する。読み取りは lease を延長しない。
- heartbeat は Run ごとに 10 秒に 1 回まで受け付け、超過分は `429` と `retryAfterSeconds` を返す。
- Phase 1 の heartbeat は MCP tool 呼び出しだけで送る。Claude Code の hooks や Kiro の agent
  hooks から定期送信する方式は後続 Phase の option とし、Codex は hook 相当の有無を確認して
  から決める。tool を呼ばない長い作業中に停滞表示になることは、停滞が「要確認」であって
  「失敗」ではないことで許容する。

### Work Item mutation との fence

- Run を開始する operation は、Work Item の `started` への遷移（既存 revision CAS）と Run の
  conditional put、`agent-run.started` audit event を 1 つの DynamoDB transaction で確定する。
  片方だけが成功した状態を作らない。
- public API の Work Item 更新（PATCH）と comment 作成は任意の `agentRunId` と
  `agentInstanceId` を受け取る。`agentRunId` が指定された場合、server は Run が `active` で、
  credential の actor が `assigneeUserId` と一致し、Run の `workItemId` が対象と一致することを
  強整合 read で事前検証する。この read は Run を予約しないため、lease 延長と mutation を確定する
  同じ transaction 内でも、Run の `state=active`、対象 `workItemId`、claim row の `runId` が指定
  された Run と一致することを条件付きで再検証する。条件を満たさない場合は lease 延長と mutation を
  行わず、`agent_run_not_active` を返す。`workItemId` が一致しない Run も同じ error で拒否する。
- どちらも指定しない更新（人間の Web 操作、SDK）は、対象 Work Item に `active` Run があっても
  従来どおり成功する。既存の client と SDK は変更不要である。
- MCP は mutation に常に `agentInstanceId` を添え、対象 Work Item と `workItemId` が一致する
  自分の `active` Run がある場合はその `runId` を `agentRunId` として添える。別の Work Item の
  Run は添えない。
- start、および `agentRunId` または `agentInstanceId` を伴う mutation は、対象 Work Item に
  別 instance の `active` Run がある場合に `409 agent_run_conflict` とし、相手 Run の
  `runtime`、`agentName`、`startedAt`、停滞かどうかだけを返す。`instanceId` hash や
  credential は返さない。

### 永続化

新しい `AgentRunsTable` を追加する。key は Work Item と同じ Team partition に揃える。

| Index | Partition key | Sort key | 用途 |
| --- | --- | --- | --- |
| table | `directoryTeamId` | `agent-run#<runId>` | Run の正本 |
| table | `directoryTeamId` | `agent-run-claim#<workItemId>` | Work Item ごとの `active` Run を 1 件に固定する claim row |
| `WorkItemRunIndex` | `directoryTeamId#<workItemId>` | `<startedAt>#<runId>` | Work Item 詳細の Run 履歴 |
| `ActiveRunIndex`（sparse） | `directoryTeamId` | `<leaseExpiresAt>#<runId>` | board の処理中・停滞一覧。`finished` で key を外す |

claim row は `runId` と `instanceId` hash を持ち、start の transaction で「存在しない」条件付き
put、finish / release / take over の transaction で同じ `runId` 条件付き delete または置換を行う。
claim row が残り Run row が `finished` になった不整合は strict reader が fail-closed で `503` とし、
[data-integrity](data-integrity.md) の verify script に検査を追加する。

Run は Work Item の archive / delete に従う。Work Item を削除する transaction は `active` Run を
`released` として閉じ、claim row を削除する。Retention は Work Item と同じとし、Run だけを
先に消さない。

## 構造化された進捗報告

`report_progress` は人が読む comment を残す現行の役割を保ちつつ、任意の構造化 field を
受け取る。

| Field | Required | Description |
| --- | --- | --- |
| `kind` | no | `progress`（既定）、`blocker`、`verification`、`artifact`、`handoff`。 |
| `message` | yes | 既存どおり最大 3,900 文字。comment 本文になる。 |
| `verifications[]` | no | 最大 20 件。`command`（最大 512 文字）、`status`（`passed`、`failed`、`skipped`）、`summary`（最大 512 文字）。 |
| `artifacts[]` | no | 最大 20 件。`type`（`pull-request`、`branch`、`commit`、`url`）、`url`、`label`（最大 128 文字）。 |
| `changedFileCount` | no | 0 以上の整数。 |

- report は Run に紐づく `AgentRunReport` row（`agent-run-report#<runId>#<sequence>`）と、
  canonical Collaboration の comment を 1 つの transaction で保存する。comment には既存どおり
  agent 名の label を付け、構造化 field は comment 本文へ埋め込まず row に保存する。
  Web は comment の横に検証結果と成果物を chip として表示する。
- `url` は `https` のみ、credential 付き URL を拒否し、最大 2,048 文字とする。server は URL を
  取得・解決しない。表示時は既存の rich text safety と同じ link 方針に従う。
- `kind=blocker` と `kind=handoff` は Factory board の「判断待ち」lane に出す。status 変更は
  伴わないため、agent は必要に応じて `move_task` を別途呼ぶ。
- `message` だけの `report_progress` は、対象 Work Item と一致する自分の `active` Run がある場合、
  report endpoint を呼び、`AgentRunReport` row と comment を保存して成功を返す。一致する Run がなく、
  対象 Work Item に別 instance の `active` Run もない場合は、従来どおり comment endpoint で comment
  だけを保存して成功を返す。別 instance の `active` Run がある場合は、`agentInstanceId` の fence に
  より `409 agent_run_conflict` を返す。
  構造化 field（`verifications`、`artifacts`、`changedFileCount`、または `progress` 以外の `kind`）
  を含む `report_progress` は、一致する Run がなければ何も保存せずに `agent_run_not_active` を返す。
  comment だけを保存して error を返す部分保存はしない。agent は停止して人に確認する。

## 仕様と context

### 受け入れ条件

Canonical Work Item に任意 field `acceptanceCriteria` を追加する。

- 要素は `{ id, text, satisfied }` とし、`text` は最大 1,024 文字、件数は最大 20。
  `id` は Work Item 内で安定し、report や comment から参照できる。
- 空の場合は属性を持たず、schema v2 の strict reader は属性の欠落を「条件なし」として受け入れる。
  schema version は変えない。
- 編集は Work Item の説明と同じ権限と revision CAS に従う。agent は `update_task` で `satisfied`
  を更新できるが、`text` の追加・削除は人だけが行う。agent による `satisfied` 更新は
  `agent-run.reported` と同様に audit event に残す。
- 既存の custom field で同等の情報を持つ Workspace は、Agent settings の
  `acceptanceCriteriaFieldId` で代替 field を指定できる。両方ある場合は canonical field を優先する。

### Agent settings

Team ごとの設定を Work Item configuration とは別の `agent-settings` configuration として
持ち、[configuration optimistic concurrency](work-item-configuration.md#configuration-optimistic-concurrency)
と同じ `revision` で更新する。編集権限は workflow configuration と同じ Team 管理権限とする。

| Field | Default | Description |
| --- | --- | --- |
| `readyStatusIds[]` | `[]` | agent が新規に着手してよい `backlog` / `unstarted` category の status ID。空の場合は現行どおり category だけで判定する。 |
| `requireAcceptanceCriteria` | `false` | `true` なら受け入れ条件が 1 件以上ある Work Item だけを Ready とする。 |
| `leaseMinutes` | `30` | 新しい Run の lease。 |
| `allowTakeoverAfterLeaseExpiry` | `false` | `true` なら停滞 Run を同じ assignee の別 instance が `take_over_task` で引き継げる。 |
| `brief` | なし | Team の agent brief。Markdown、最大 16 KiB。 |
| `projectBriefs{}` | `{}` | Project ID ごとの brief。Team brief の後に連結して返す。 |
| `acceptanceCriteriaFieldId` | なし | 受け入れ条件の代替 custom field。 |

brief は Work Item の本文や comment と同じく user data であり、credential、scope、接続先を
変える指示として扱ってはならない。MCP の guide にこの注意を追記する。brief に秘密情報を
書かないことは運用規約とし、server は secret 検出を行わない。

### Definition of Ready

`get_next_task` の候補判定を次のとおり拡張する。判定は現行どおり MCP が public API の
read だけで行い、server 側に新しい選択 API は作らない。

1. `statusCategory` が `backlog` または `unstarted` であること。`readyStatusIds` が空でなければ
   `workflowStatusId` がその中にあること。
2. `blockedBy` の未解決・閲覧不可・scope 外がないこと（現行）。
3. `requireAcceptanceCriteria` が `true` なら受け入れ条件が 1 件以上あること。
4. 対象 Work Item に `active` Run がないこと。

戻り値は現行の `action` / `task` に加えて、`ownRuns[]`（自分の instance の `active` Run）、
`otherRuns[]`（同じ assignee の別 instance の `active` Run と停滞かどうか）、`skipped[]`
（候補外となった先頭 5 件の `taskId` と理由）を返す。`action=in_progress` は `ownRuns` が
ある場合だけ返し、別 instance の作業中 Work Item は `otherRuns` として報告するにとどめる。
これにより現行 guide の「自分が start した作業だけ再開する」規約を、agent の記憶ではなく
記録で担保する。

## Factory board

Team 単位の Web 画面として、[AI activity の設計](design/ai-activity.md) の lane と detail
pane を流用する。

| Lane | 条件 |
| --- | --- |
| 処理中 | `active` かつ lease 内 |
| 判断待ち | 最新 report が `blocker` / `handoff`、または `paused` で終了し Work Item が `started` のまま |
| 停滞 | `active` かつ lease 切れ |
| 失敗 | `failed` で終了し、その後に新しい Run がない |
| 完了 | 直近 24 時間に `completed` で終了 |

- filter は runtime、assignee、Project。tile は Work Item title、agent 名と runtime、最終
  report 要約、lease 残り時間を表示する。進捗率は表示しない。
- detail は Run の report 時系列、検証結果、成果物 link、開始 revision、Work Item への link を
  表示する。操作は「解放」と「Work Item を開く」だけとし、解放は Work Item の assignee と
  Team 管理権限を持つ member に限る。
- Run のない `started` Work Item（旧 MCP build や人の操作で開始されたもの）は「Run なし」として
  処理中 lane の末尾に区別して出す。
- data は session 認証の内部 API `GET /api/teams/{teamId}/agent-runs` から取得し、更新は既存
  画面と同じ再取得に従う。realtime 配信は後続 Phase で検討する。
- 既存の AI activity board は AI draft の session 内状態を扱う別物であり、Phase 1 では統合しない。

## Public API

Run は Work Item の sub-resource とし、新しい scope は追加しない。読み取りは `work-items:read`、
更新は `work-items:write` と、credential owner の Team RBAC の積集合で判定する。

| Method / Path | 用途 |
| --- | --- |
| `POST /v1/work-items/{workItemId}/agent-runs` | claim と `started` 遷移。body は `expectedRevision`、`workflowStatusId`、`runtime`、`agentName`、`instanceId`、`teamId`。 |
| `GET /v1/work-items/{workItemId}/agent-runs` | Work Item の Run 履歴。cursor pagination。 |
| `GET /v1/agent-runs/{runId}` | Run 1 件。 |
| `GET /v1/agent-runs?teamId=&state=&instanceId=` | Team の Run 一覧。`instanceId` は hash 前の値を送り、server が hash して照合する。 |
| `POST /v1/agent-runs/{runId}/heartbeat` | lease 延長。body なし。 |
| `POST /v1/agent-runs/{runId}/reports` | 構造化 report と comment の保存。 |
| `POST /v1/agent-runs/{runId}/finish` | `outcome` 付きの終了。 |
| `POST /v1/work-items/{workItemId}/agent-runs/{runId}/take-over` | 停滞 Run の引き継ぎ。設定で許可時のみ。 |
| `PATCH /v1/work-items/{workItemId}` / `POST .../comments` | 既存。任意 `agentRunId` と `agentInstanceId` を追加。 |

内部 API は `GET /api/teams/{teamId}/agent-runs` と
`POST /api/teams/{teamId}/agent-runs/{runId}/release` を追加し、Web 画面だけが使う。

Error は既存の `ApiProblem` に次の code を追加する。

| Status | Code | 条件 |
| --- | --- | --- |
| `409` | `agent_run_conflict` | 対象 Work Item に別 instance の `active` Run がある |
| `409` | `agent_run_not_active` | 指定 Run が `finished`、または対象 Work Item と一致しない |
| `403` | `agent_run_forbidden` | credential の actor が Run の `assigneeUserId` と異なる |
| `409` | `not_ready` | start 対象が Agent settings の Ready 条件を満たさない |
| `422` | `invalid_artifact_url` | report の URL が許可形式でない |

OpenAPI document と `api:contract:check` の baseline を同じ変更で更新する。

### 冪等性と競合

- start、report、finish、take over は既存どおり `Idempotency-Key` を必須とし、同じ key と同じ
  引数の再送は保存済み receipt を返す。異なる引数は `409 idempotency_conflict`。
- 同じ revision に対する異なる key の並行 start は、Work Item の revision CAS と claim row の
  条件付き put のどちらかで 1 つだけ成功する。敗者は `agent_run_conflict` を受け取り、Work
  Item を再取得してから次の行動を決める。
- heartbeat は key を要求せず、自然に冪等である。
- finish 済み Run への finish は、同じ key なら receipt を返し、異なる `outcome` なら
  `agent_run_not_active` を返す。
- 人が解放した後の agent からの mutation は `agent_run_not_active` になる。MCP は作業を
  止め、ユーザーに状況を報告する。解放は agent へ push 通知しない。
- report の `sequence` は Run ごとに server が採番し、transaction 内で `reportCount` を条件付き
  更新する。順序は server の採番順であり、client の時刻に依存しない。

## MCP contract の変更

環境変数を 2 つ追加する。

| 環境変数 | 必須 | 用途 |
| --- | --- | --- |
| `MUKUROJI_MCP_RUNTIME` | 任意 | `claude-code`、`codex`、`kiro`、`other`。既定 `other`。 |
| `MUKUROJI_MCP_INSTANCE_ID` | 任意 | instance の安定 ID。未指定時は hostname、OS user 名、runtime、assignee から導出した hash を使い、raw 値は送らない。 |

tool は次のとおり変更・追加する。

| Tool | 変更 |
| --- | --- |
| `get_configuration` | `agentSettings`（`readyStatusIds`、`requireAcceptanceCriteria`、`leaseMinutes`、`allowTakeoverAfterLeaseExpiry`）と `brief` を追加。 |
| `get_next_task` | `ownRuns`、`otherRuns`、`skipped` を追加。Ready 判定を Agent settings に従わせる。 |
| `get_task` | `acceptanceCriteria` と `activeRun`（自他の区別付き）を追加。 |
| `start_task` | Run の start endpoint を呼ぶ。戻り値に `run` を追加。`not_ready` と `agent_run_conflict` をそのまま返す。 |
| `heartbeat`（新規） | `runId` を受け取り lease を延長する。 |
| `finish_run`（新規） | `runId`、`outcome`、`idempotencyKey`。`complete_task` の後、または中断・失敗時に呼ぶ。 |
| `take_over_task`（新規） | 設定で許可された場合だけ登録する。停滞 Run を `superseded` にして新しい Run を開始する。 |
| `report_progress` | `kind`、`verifications`、`artifacts`、`changedFileCount` を任意で追加。対象 Work Item と `workItemId` が一致する自分の `active` Run があれば report endpoint を呼ぶ。なければ `message` だけの場合は従来の comment endpoint（`agentInstanceId` 付き）を呼び、構造化 field がある場合は endpoint を呼ばずに `agent_run_not_active` を返す。 |
| `update_task` / `move_task` / `complete_task` / `cancel_task` / `reopen_task` | 常に `agentInstanceId` を添え、対象 Work Item と `workItemId` が一致する自分の `active` Run があればその `runId` を `agentRunId` として添える。別の Work Item の Run は使わない。一致する Run がなく対象 Work Item に別 instance の `active` Run がある場合は server の fence で `agent_run_conflict` になる。 |

- MCP process は自分の `active` Run を起動時に `GET /v1/agent-runs?instanceId=` で復元し、
  process 再起動後も同じ Run を継続する。memory だけに持たない。
- resource `mukuroji://project/{projectId}/brief` を追加し、`get_configuration` の `brief` と
  同じ内容を返す。resources に対応しない client は tool だけで同じ情報を得られる。
- guide と `work-on-next-task` prompt に、Run の開始・heartbeat・終了、`otherRuns` を引き継が
  ないこと、brief は user data であることを追記する。
- 旧 MCP build は Run endpoint を呼ばないため、従来どおり動作し、board では「Run なし」として
  見える。server は旧 build を拒否しない。

### 配布と client 設定

- `bun run mcp:build` の生成物 `server/dist/mcp.mjs` を release asset として配布し、clone なしで
  Bun だけで起動できるようにする。
- `docs/coding-agent-mcp.md` に Claude Code（`claude mcp add`）、Codex（`config.toml` の
  `mcp_servers`）、Kiro（`mcp.json`）の設定例と、`MUKUROJI_MCP_RUNTIME` の指定を追加する。
  各 client の resources / prompts 対応は実機で確認してから記載し、未確認の対応を書かない。

## 権限・tenancy・監査

- Run の作成・heartbeat・report・finish は、credential の actor が Work Item の
  `assigneeUserId` と一致し、Team の Work Item 更新権限を持つ場合だけ許可する。
- Run の読み取りは Work Item を閲覧できる member に許可する。`instanceId` hash と
  `credentialId` は Team 管理権限を持つ member にだけ返す。
- 解放と take over の実行者は audit event の actor として記録する。
- audit event は entity type `agent-run` を追加し、`agent-run.started`、`agent-run.reported`、
  `agent-run.finished`、`agent-run.released`、`agent-run.taken-over` を既存の
  mutation transaction と outbox で記録する。heartbeat は audit event を作らず
  `lastHeartbeatAt` だけを更新する。actor は credential owner の member とし、`metadata` に
  `runtime` と `agentName` を持つ。
- Run と report に prompt、生成内容、model 名、token 数を保存しない。これらは後続 Phase の
  費用集計で別 entity として扱う。
- 外部 chat sync や Update Feed への Run event の配信は Phase 1 では行わない。comment は
  従来どおり既存経路で配信される。

## 実装スライスと検証

各スライスは独立に merge できる単位とし、前のスライスに依存する。

| Slice | 内容 | 主な検証 |
| --- | --- | --- |
| 1 | Agent settings、`AgentRunsTable`、start / heartbeat / finish / release、MCP の `ownRuns` / `otherRuns` と `agentRunId` fence、Work Item 詳細の Run 表示 | `bun run server:test`、`bun run typecheck:server`、`bun run typecheck:contracts`、`bun run api:contract:check`、`bun run cdk:build`、`bun run cdk:test`、MCP stdio 結合 test |
| 2 | 構造化 report、artifact 検証、comment chip 表示、3 client の設定例、配布 build | `bun run server:test`、`bun run web:test`、`bun run mcp:build`、`bun run knip:check` |
| 3 | 受け入れ条件、Ready 判定、brief と resource、`not_ready` | `bun run server:test`、`bun run typecheck:contracts`、`bun run dependencies:check`、`bun run api:contract:check` |
| 4 | Factory board、内部 Run 一覧 API、解放 | `bun run web:lint`、`bun run web:test`、`bun run web:build`、`bun run web:build-storybook`、Storybook での desktop / phone 確認 |

Slice 1 の MCP 結合 test は、同じ assignee の 2 つの MCP process を異なる `instanceId` で起動し、
一方の `start_task` 成功後に他方の `start_task` が `agent_run_conflict` になること、他方の
`get_next_task` が `otherRuns` として報告し `in_progress` にしないこと、解放後に他方が開始
できることを検証する。

## 後続 Phase

- GitHub adapter を `ConnectorAdapter` 境界の後ろに実装し、report の `pull-request` artifact を
  external link と突き合わせて CI、レビュー、merge 状態を取り込む。
- Work Item に Gate（CI、bot review、人の承認）を持たせ、`complete` 遷移の server 検証に
  組み込む。既存の approval action を再利用する。
- stage 別 lead time、Run の成功 / 手戻り率、token 費用を analytics に追加する。
- `failed` Run と停滞を Triage entry として自動起票する automation trigger を追加する。
- hooks による heartbeat、planner / implementer / reviewer の多段 Run を Work Item relation と
  Run の親子で表現する。

## 決定事項と保留

決定済み:

- 責任者は人間の member のまま、runtime と instance は Run に記録する。
- lease は tool 呼び出しで延長し、停滞は人が判断する。自動 take over は既定で無効。
- Ready は Agent settings が指す workflow status で表し、workflow configuration の schema は変えない。
- Run と report は public API の Work Item sub-resource とし、新しい scope を作らない。

保留:

- `leaseMinutes` の既定値 30 分が実際の作業間隔に合うか。Slice 1 の運用で見直す。
- report を Update Feed と Inbox digest に出すか。Phase 1 は comment の既存配信に任せる。
- Kiro と Codex の resources / prompts 対応。確認結果を `docs/coding-agent-mcp.md` に記す。
- Run のない `started` Work Item を将来 Ready 判定でどう扱うか。
