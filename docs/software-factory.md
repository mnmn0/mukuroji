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
  Run の開始時に当時の値を `leaseMinutes` として固定し、設定変更は新しい Run から効く。start は
  読んだ設定の revision（未保存なら設定 row がないこと）を同じ transaction で検査し、開始中に
  保存された設定を取りこぼした Run を確定しない。
- `heartbeat` と Run 配下の mutation（report、`agentRunId` 付き Work Item 更新）は
  `lastHeartbeatAt` を更新する。読み取りは lease を延長しない。lease は `lastHeartbeatAt < now`
  を条件に更新し、遅れて届いた更新で期限を戻さない。
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
  強整合 read で事前検証する。この read は Run を予約しないため、mutation を確定する同じ
  transaction 内でも、Run の `state=active`、対象 `workItemId`、claim row の `runId` が指定
  された Run と一致することを ConditionCheck で再検証する。条件を満たさない場合は mutation を
  行わず、`agent_run_not_active` を返す。lease は commit 後に延長する。`workItemId` が一致しない Run も同じ error で拒否する。
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
| table | `directoryTeamId` | `agent-run-revoked#<workItemId>#<member と instance の hash>` | 人が解放した、または別 instance が引き継いだ Run の member と instance。fence が強整合で読む |
| table | `directoryTeamId` | `agent-settings-mutation#<key hash>` | Agent settings の保存ごとの receipt。同じ key の再送を判定する |
| `WorkItemRunIndex` | `directoryTeamId#<workItemId>` | `<startedAt>#<runId>` | Work Item 詳細の Run 履歴 |
| `ActiveRunIndex`（sparse） | `directoryTeamId` | `<leaseExpiresAt>#<runId>` | board の処理中・停滞一覧。`finished` で key を外す |

claim row は `runId` と `instanceId` hash を持ち、start の transaction で「存在しない」条件付き
put、finish / release / take over の transaction で同じ `runId` 条件付き delete または置換を行う。
claim row が残り Run row が `finished` になった不整合は strict reader が fail-closed で `503` とし、
[data-integrity](data-integrity.md) の verify script に検査を追加する。

revocation row は Run を `released` または `superseded` で閉じる transaction で書き、同じ member と
instance がその Work Item で Run を開始する transaction でだけ削除する。別 instance の Run が開始・
終了しても消えない。Work Item の削除で Run を解放する場合も書く。Work Item ID は削除後に同じ
title から再作成されると再利用されるため、revocation row は解放済み instance が再作成された Work Item を
Run なしで更新しないための tombstone を兼ね、Run row と同じく Work Item の削除後も保持する。
結果整合の `WorkItemRunIndex` は fence の判断に使わない。

Run は Work Item の archive / delete に従う。Work Item を削除または archive する transaction は
`active` Run を `released` として閉じ、claim row を削除する。Retention は Work Item と同じとし、Run だけを
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

- report は Run に紐づく `AgentRunReport` row と canonical Collaboration の comment を 1 つの
  transaction で保存する。row の sort key は
  `agent-run-report#<workItemId の SHA-256（base64url）>#<createdAt>#<runId>#<sequence>` とし、Work Item の
  report を作成順に強整合の Query 1 回で読めるようにする。Run row の更新は `lastHeartbeatAt` が report
  時刻以下であることも条件にし、report より新しい heartbeat の lease を巻き戻さない。comment 本文は Run に記録した agent 名の
  label（`[agentName]`）と `message` で server が組み立て、構造化 field は本文へ埋め込まず row に
  保存する。Web は comment の横に検証結果と成果物を chip として表示する（Slice 2 の Web 変更）。
- 同じ transaction で Run row の `reportCount` を読み取り時の値で条件付き更新し（report の
  `sequence` になる）、lease を延長し、最新 report の kind と時刻（`lastReportKind`、
  `lastReportAt`）を Run row に残す。後者は Factory board 用で、Public API の Run には返さない。
  claim の保持確認、`agent-run.reported` audit event、idempotency receipt も同じ transaction に入れる。
  comment の ID は audit context から決定的に導出するため、receipt に comment を含められる。
- 並行する別の report が先に確定した場合は、同じ引数と key の再送で次の `sequence` として保存できる
  `503 temporarily_unavailable` を返す。Run が先に終了・解放・引き継ぎされた場合は
  `agent_run_not_active`、別 instance の Run への report は `agent_run_conflict`（pointer
  `/instanceId`）、Work Item の担当者が変わった場合は `agent_run_forbidden` とする。
- agent の finish と Web からの解放は、読み取った Run の `reportCount` と `lastHeartbeatAt` も close の
  条件にする。先に report・heartbeat・lease 延長が確定した場合は close を確定させず、Run を読み直して
  組み立て直す（最大 3 回、超えたら `503 temporarily_unavailable`）。これにより finish の応答と receipt、
  解放の応答は確定した Run row と一致する。Work Item の削除・archive に伴う解放はこの条件を付けない。
- `url` は小文字の `https://` で始まり host を持つもののみ、credential 付き URL（authority 内の `@`）、
  backslash、空白・制御文字を拒否し、最大 2,048 文字とする。presigned URL や token parameter を保存しないよう、query と `=` を
  含む fragment も拒否する（`#discussion_r1` のような anchor は許可する）。違反は `400 validation_failed` と `errors[].code`
  `invalid_artifact_url` で返す。server は URL を取得・解決しない。表示時は既存の rich text safety と
  同じ link 方針に従う。
- verification の `command`・`summary` と artifact の `label` は改行と tab 以外の制御文字を含まない 1 行、
  `message` は改行と tab のみ許可し、いずれも空白だけの値は拒否する。URL と合わせ、これらの pattern は
  contracts の定数として OpenAPI と MCP の tool schema に同じものを公開する。URL は pattern に加えて
  URL として解釈できること（host と port の妥当性）も必要で、server と MCP は contracts の
  `isAgentRunArtifactUrl` で同じ判定を行う。OpenAPI では `format: uri` と説明で示す。
- Web は `GET /api/teams/{teamId}/work-items/{workItemId}/agent-run-reports?limit=`（既定 100 件、
  新しい順）で Work Item を閲覧できる member に report を返す。page の JSON が約 1 MB を超える場合は
  そこで打ち切り（最新の 1 件は必ず含める）、`hasMore: true` を返して Lambda の応答上限に収める。
- `kind=blocker` と `kind=handoff` は Factory board の「判断待ち」lane に出す。status 変更は
  伴わないため、agent は必要に応じて `move_task` を別途呼ぶ。
- `message` だけの `report_progress` は、対象 Work Item と一致する自分の `active` Run がある場合、
  report endpoint を呼び、`AgentRunReport` row と comment を保存して `{ comment, report, run }` を返す。一致する Run がなく、
  対象 Work Item に別 instance の `active` Run もない場合は、従来どおり comment endpoint で comment
  だけを保存して `{ comment }` を返す。別 instance の `active` Run がある場合は、`agentInstanceId` の fence に
  より `409 agent_run_conflict` を返す。
  構造化 field（`verifications`、`artifacts`、`changedFileCount`、または `progress` 以外の `kind`）
  を含む `report_progress` は、一致する Run がなければ何も保存せずに `agent_run_not_active` を返す。
  comment だけを保存して error を返す部分保存はしない。agent は停止して人に確認する。
- MCP は直近 100 件の report key を Work Item ごとに、送った先（Run の report endpoint、または comment
  endpoint とその fence）と一緒に覚える。応答が失われた後の再送は、間に Run が終了・開始しても同じ
  request を送り、server の receipt を再生する。別の Work Item に同じ key を使った場合はその Work Item の
  request として送るため、server が idempotency conflict として拒否する。この記憶は MCP の process 内だけに
  ある。再起動後や 100 件を超えて追い出された後でも再送が同じ endpoint に届くように、送り先は request
  自体からも決まる。
  - `report_progress` に `runId` を付けた report は、常にその Run の report endpoint に送る。Run が終了
    した後でも、同じ `runId` と key の再送は server の receipt を再生する。agent は Run を持つ間、毎回
    `runId` を付ける。
  - Run がない間の通常メッセージは、comment endpoint に instance だけの fence で送る。再起動後の再送が
    後から始まった Run の report endpoint で idempotency conflict になった場合は、同じ comment request を
    1 回だけ送り直し、最初の comment を再生する。
  - Run の間に `runId` を付けずに送った report の再起動後の再送は、Run が終了していれば
    `agent_run_not_active`（構造化 report の場合）、新しい Run が始まっていれば idempotency conflict に
    なる。処理中の同じ request による retryable な conflict では comment endpoint へ送り直さない。どの
    場合も 2 件目を保存することはない。

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

## Triage への自動起票

`failed` で終わった Run と停滞した Run を、Team の Triage に `agent-run` source の entry として
自動で起票する。判断待ちの作業を人が拾う場所を Triage に一本化し、Factory board を開かなくても
見落とさないようにする。既定では無効とし、Team が Agent settings で有効にする。

| Field | Default | Description |
| --- | --- | --- |
| `fileFailedRunsToTriage` | `false` | `true` なら `failed` で終わった Run ごとに Triage entry を 1 件起票する。 |
| `fileStalledRunsToTriage` | `false` | `true` なら停滞（`active` のまま lease 切れ）した Run ごとに Triage entry を 1 件起票する。 |

- source kind に `agent-run` を追加する。routing rule と SLA policy は他の source と同じく
  source kind で対象を選べる。entry の requester は Run の agent 名で、guest ではない。
  返信先がないため `canReply` は `false` とする。entry の Project は Run の Work Item の Project とし、
  Project を限定された閲覧者には、その Project を見られる場合だけ entry を見せる。routing rule が
  entry を別の Project へ移す場合は、Work Item の title と path が別 Project の閲覧者に見えないよう
  起票を拒否する。
- entry は Run ごとに 1 件とし、source ID は Run ID にする。Triage の source claim で重複を防ぎ、
  同じ Run を何度処理しても 2 件目は作らない。停滞として起票した Run が後で `failed` で終わっても、
  最初の entry の replay になる。停滞 Run が
  heartbeat で回復しても entry はそのまま残し、判断は Triage の担当者に任せる。
- 本文は agent 名と runtime、Work Item の title と画面への path、Run ID、終了時刻または lease の
  期限、最新 report の kind を書く。report の本文と成果物 link は含めない。Work Item への link は
  Triage の accept / link 操作で人が行う。title と本文は Triage の上限（500 文字と 8,000 文字）に収まるよう切り詰める。
- 起票は API request とは別の定期 worker（1 分ごと）が行う。audit stream にはすでに 3 つの
  consumer があり、DynamoDB stream の reader をこれ以上増やさない。
  - `failed` の finish は、Run の行に outbox key を同じ transaction で書く。worker はこの key を
    古い順に読み、Team の設定が有効なら起票し、無効なら起票せずに key を消す。起票に成功するか
    既に起票済みなら key を消す。一時的な失敗は key を残して次の実行で再試行し、入力が Triage に
    拒否された場合は key を消して記録する。
  - 停滞は、どちらかの設定を有効にした Team を index から列挙し、`ActiveRunIndex` を lease の
    古い順に lease 切れの範囲だけ読む。起票した Run には印を付ける。放置された Run は `active` の
    まま index に残るため、Team ごとに最後に処理した Run の位置（watermark）を保存し、次の実行は
    その後ろから読む。lease は後ろにしか動かないため、watermark より前の Run は処理済みである。
    index は結果整合なので、watermark は lease 切れから 15 分以上経った Run までしか進めない。
    まだ index に現れていない Run を飛び越えるのは、index の遅れが lease と 15 分の和を超えた
    場合だけになる。多数の Run が同時に停滞し、settle 前に 1 回の読み取り上限へ達した場合は、
    最後に処理した Run の位置（resume）も保存し、次の実行はその後ろから続ける。最後まで読んだら
    resume を消し、次の実行は watermark から読み直す。watermark を進めるのは watermark から
    読み始めた実行だけとし、遅れて index に現れた Run を飛び越えない。
    起票に一時的に失敗した Run の手前で watermark を止め、次の実行で再試行する。
  - 処理する Team 数や起票件数の上限で止まった場合は、止まった Team を保存し、次の実行はその Team
    から再開する。最後の Team まで処理したら保存を消し、次は先頭の Team から読む。
  - 両方とも `AgentRunsTable` の sparse GSI `AgentRunTriageIndex` を使う。partition は
    `triage-filing-team`（設定の行）と `triage-failed-run`（outbox）の 2 つで、どちらも件数が
    少ないため shard しない。GSI は table 更新ごとに 1 つしか追加できないため 1 つにまとめる。
- worker の 1 回の処理件数には上限を設け、上限に達した場合は記録して次の実行に続ける。

## Public API

Run は Work Item の sub-resource とし、新しい scope は追加しない。読み取りは `work-items:read`、
更新は `work-items:write` と、credential owner の Team RBAC の積集合で判定する。

| Method / Path | 用途 |
| --- | --- |
| `POST /v1/work-items/{workItemId}/agent-runs?teamId=` | claim と `started` 遷移。body は `expectedRevision`、`workflowStatusId`、`runtime`、`agentName`、`instanceId`。Team は既存の Work Item route と同じく query で指定する。 |
| `GET /v1/work-items/{workItemId}/agent-runs` | Work Item の Run 履歴。cursor pagination。 |
| `GET /v1/agent-runs/{runId}` | Run 1 件。 |
| `GET /v1/agent-runs?teamId=&state=&instanceId=&assigneeUserId=&workItemId=` | Team の Run 一覧。`state` は `active`（既定、lease の早い順）または `finished`。`instanceId` は hash 前の値を送り、server が hash して照合する。`workItemId` を指定すると index ではなく claim row を強整合で読み、その Work Item を claim している Run だけを返す（`state=active` のみ）。閲覧できない Work Item の Run は返さない。 |
| `GET /v1/agent-settings?teamId=` | Team の Agent settings（lease と take over）。MCP の `get_configuration` が使う。 |
| `GET /v1/agent-context?teamId=` | Ready status と agent brief。閉じた `AgentSettings` schema を広げないための別 path。MCP の `get_configuration` と `get_next_task` が使う。 |
| `POST /v1/agent-runs/{runId}/heartbeat` | lease 延長。body は Run 開始時と同じ `instanceId`。 |
| `POST /v1/agent-runs/{runId}/reports` | 構造化 report と comment の保存。 |
| `POST /v1/agent-runs/{runId}/finish` | 終了。body は `outcome` と Run 開始時と同じ `instanceId`。 |
| `POST /v1/work-items/{workItemId}/agent-runs/{runId}/take-over` | 停滞 Run の引き継ぎ。設定で許可時のみ。 |
| `PATCH /v1/work-items/{workItemId}` / `POST .../comments` | 既存。任意 `agentRunId` と `agentInstanceId` を追加。 |

内部 API は Web 画面だけが使い、Public OpenAPI document には含めない。次を提供する。

| Method / Path | 用途 |
| --- | --- |
| `GET /api/teams/{teamId}/agent-runs` | Factory board の 1 回分の data（Slice 4）。Team を閲覧できる member に、lane に入る Work Item と、その `active` Run または最新の Run、Run の最新 report の要約を返す。読み取りはすべて上限付きで、上限に達した読み取り元ごとに `...HasMore` を返す。store cursor は返さない。 |
| `GET /api/teams/{teamId}/work-items/{workItemId}/agent-runs?limit=` | Work Item 詳細に出す新しい順の Run（既定 20 件）と `hasMore`。table key を含む store cursor は返さない。各 Run に閲覧者が解放できるかどうか（`canRelease`）を付ける。 |
| `POST /api/teams/{teamId}/agent-runs/{runId}/release` | `active` Run の解放。Run を開始した member、Work Item の現在の assignee、または Team manager に限る。解放済みへの再送は現在の Run を返す。 |
| `GET /api/teams/{teamId}/agent-settings` / `PUT ...` | Agent settings の取得と、Team manager による `revision` CAS 付き更新。保存ごとに `Idempotency-Key` 由来の key の receipt row（`agent-settings-mutation#<key hash>`）を同じ transaction で書き、応答を失った同じ key と同じ値の再送は revision 不一致でも receipt の設定を返す。一度確定した key は、後で別の key の保存があっても、別の値や別の revision で再利用すると `409` にする。 |

`ApiProblem.code` の enum は Public API の後方互換性（response enum を広げない）のため変えない。
Run 固有の理由は既存の `conflict` / `forbidden` に対応する problem の `errors[].code` で返し、
`pointer` に関係する request field を入れる。

| Status | `code` | `errors[].code` | 条件 |
| --- | --- | --- | --- |
| `409` | `conflict` | `agent_run_conflict` | 対象 Work Item に別 instance の `active` Run がある、または別 instance の `active` Run を heartbeat・finish しようとした。`detail` に保持 Run の agent 名、runtime、開始時刻、停滞かどうかを含める。 |
| `409` | `conflict` | `agent_run_not_active` | 指定 Run が `finished`、別 instance のもの、または対象 Work Item と一致しない |
| `403` | `forbidden` | `agent_run_forbidden` | credential の actor が Work Item または Run の `assigneeUserId` と異なる |
| `403` | `forbidden` | `agent_run_takeover_disabled` | Team の Agent settings が take over を許可していない |
| `409` | `conflict` | `invalid_transition` | start 対象が `backlog` / `unstarted` でない、または遷移先が `started` でない |
| `409` | `conflict` | `not_ready` | start 対象が Agent settings の Ready 条件を満たさない（Slice 3） |
| `400` | `validation_failed` | `invalid_artifact_url` | report の URL が許可形式でない |

Run と claim の行が食い違う場合は修復せず `503 temporarily_unavailable` とする。

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
| `take_over_task`（新規） | 停滞 Run を `superseded` にして新しい Run を開始する。tool は常に登録し、Team の設定が許可していない場合は server が `agent_run_takeover_disabled` を返す。ユーザーが明示的に引き継ぎを指示した場合だけ使う。 |
| `report_progress` | `kind`、`verifications`、`artifacts`、`changedFileCount` を任意で追加。対象 Work Item と `workItemId` が一致する自分の `active` Run があれば report endpoint を呼ぶ。なければ `message` だけの場合は従来の comment endpoint（`agentInstanceId` 付き）を呼び、構造化 field がある場合は endpoint を呼ばずに `agent_run_not_active` を返す。 |
| `update_task` / `move_task` / `complete_task` / `cancel_task` / `reopen_task` | 常に `agentInstanceId` を添え、対象 Work Item と `workItemId` が一致する自分の `active` Run があればその `runId` を `agentRunId` として添える。別の Work Item の Run は使わない。一致する Run がなく対象 Work Item に別 instance の `active` Run がある場合は server の fence で `agent_run_conflict` になる。 |

- MCP process は自分の `active` Run を memory に持たず、`GET /v1/agent-runs?instanceId=` と、
  対象タスクの claim を強整合で読む `workItemId` 指定の一覧で判定する。process 再起動の直後に
  index がまだ Run を返さなくても、同じ Run を継続する。
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
| 5 | `failed` / 停滞 Run の Triage 自動起票、`agent-run` source、起票 worker | `bun run server:test`、`bun run web:test`、`bun run typecheck:contracts`、`bun run cdk:build`、`bun run cdk:test` |

Slice 1 の MCP 結合 test は、同じ assignee の 2 つの MCP process を異なる `instanceId` で起動し、
一方の `start_task` 成功後に他方の `start_task` が `agent_run_conflict` になること、他方の
`get_next_task` が `otherRuns` として報告し `in_progress` にしないこと、解放後に他方が開始
できることを検証する。

### Slice 1 の実装状況

Slice 1 は実装済みである。設計からの具体化と、意図的に後へ回した点は次のとおり。

- start は Public Work Item 更新と同じ経路（RBAC、workflow 遷移検証、revision CAS、
  idempotency receipt）を通し、Run と claim の put、`agent-run.started` audit event を同じ
  transaction に加える。receipt は `201` の `{ run, workItem }` を保存し、再送も同じ応答を返す。
- PATCH と comment の fence は、Run と claim を ConditionCheck で Work Item 更新・comment 保存と
  同じ transaction に入れて検証し、commit 後に lease を延長する。延長は `lastHeartbeatAt < now`
  を条件にするため、並行する mutation や heartbeat の順序が入れ替わっても lease は戻らない。
  延長の失敗で mutation を失敗にはしない。Run で fence する mutation は、Work Item の現在の担当者が
  Run の開始者である場合だけ受け付ける（`agent_run_forbidden`）。PATCH は revision CAS で、comment は
  comment 保存が既に持つ担当者の ConditionCheck で、読んだ後の担当変更と競合した mutation を確定しない。
- heartbeat と finish は Run 開始時の `instanceId` を必須とし、その hash を Run の条件式でも
  照合する。同じ credential を共有する別 instance は、他 instance の Run を延長・終了できない。
- `agentRunId` は `agentInstanceId` と一緒に送る。`agentInstanceId` だけの mutation は、別
  instance の claim がない場合だけ成功する。instance は credential の member と組で識別し、別の
  member が同じ instance ID を使っても他 member の claim や解放の記録とは一致しない。自分の claim を
  持つ場合は claim が指す Run を読み、Run ID を送った場合と同じく Run と claim の両方で fence する。
  claim がなく、その member と instance の revocation row がある場合は `agent_run_not_active` とする。
  revocation row は強整合で読み、mutation と同じ transaction でも ConditionCheck で再検証するため、
  人が解放した直後や解放と同時に届いた mutation、その後に別 instance が作業した後の mutation も止まる。
- heartbeat は Run の lease 更新と、claim row が同じ Run と instance を指すことの ConditionCheck を
  1 つの transaction で行う。claim を失った `active` Run は integrity error として延長しない。
  heartbeat は Work Item の現在の担当者だけが送れ、読んだ Work Item の revision を同じ transaction で
  検査する。担当が変わった後の前任者は lease を延長できないが、`finish_run` で閉じることはできる。
  finish も認可に使った Work Item の revision を同じ transaction で検査し、Project 移動などと競合した
  終了を確定しない。
- Work Item の削除と一括 archive は `active` Run を `released` にし、claim を削除する。Run が
  ない場合も claim がないことを同じ transaction で検査し、削除・archive と start の競合を防ぐ。
- Web の解放が Work Item の現在の担当者であることだけを根拠にする場合、読んだ Work Item の
  revision を同じ transaction で検査し、担当変更と競合した解放を確定しない。
- Run 一覧の可視性は Work Item を強整合で読んで判定する。index は閉じた直後の Run を `active` と
  返すことがあるため、一覧は各 Run を強整合で読み直し、要求した状態のものだけを返す（読み取りは
  同時 10 件まで）。Work Item の Run 履歴も同じく各 Run を強整合で読み直す。Web の Run パネルは
  解放の応答を表示に反映してから背景で再取得し、開いている間
  30 秒ごと、および `active` Run の lease が切れる直後に再取得し、停滞を表示する。新しい 20 件より前の
  Run がある場合は、表示が新しい Run に限られることを示す。
- `MUKUROJI_MCP_PROJECT_ID` を設定した MCP は、Project 外のタスクの Run を `ownRuns` / `otherRuns` に
  含めず、`heartbeat` と `finish_run` も `out_of_scope` で拒否する。
- `instanceId` hash と `credentialId` は保存するが、Slice 1 ではどの API も返さない。
- MCP の `get_next_task` は、自 instance の Run があり、かつ Work Item がまだ `started` のものだけを
  `in_progress` とする。Run 一覧の index は結果整合のため、index にない `started` タスクはすべて
  claim を強整合で読み（同時 10 件ずつ）、自 instance の Run を `ownRuns` に含める。`get_task` の
  `activeRun`、`heartbeat` / `finish_run` の所有確認、mutation の fence も claim を読んで決めるため、
  開始直後や process 再起動直後でも同じ Run を扱える。所有は member と instance の組で判定し、claim の
  読み取りにも担当者を含める。それ以外の自 Run は `ownRuns` に残し、agent に
  `finish_run` を促す。
  Run のない `started` Work Item は再開対象にしない。
- take over は `POST /v1/work-items/{workItemId}/agent-runs/{runId}/take-over` で受け付ける。
  `allowTakeoverAfterLeaseExpiry` が `true`、Work Item と停滞 Run の担当者がどちらも credential の
  member、Work Item が `started`、Run が別 instance のもので lease が切れている場合だけ成功する。停滞 Run の `superseded`
  への更新（lease が切れたままであることを条件にする）、claim row の置き換え（停滞 Run の
  `runId`、instance、member をすべて保持していることを条件にする）、旧 instance の revocation row、新しい Run、Work Item revision と設定
  revision の ConditionCheck、旧 Run の `agent-run.taken-over` と新しい Run の `agent-run.started` の
  audit event、idempotency receipt を 1 つの transaction で確定
  する。heartbeat が先に lease を延長した場合は `agent_run_conflict` で拒否する。Run の読み取り後に
  finish、release、別の take over が先に確定して claim が消えた・置き換わった場合は Run を読み直し、
  `agent_run_not_active` を返す。停滞したままの Run を claim が保持していない場合だけ `503` にする。
  Work Item revision や設定 revision の ConditionCheck で取り消された場合は両方を読み直し、担当者の
  変更は `403`、`started` 以外への移動は `invalid_transition`、take over の無効化は
  `agent_run_takeover_disabled`、それ以外の変更は `409` として返す。
  Work Item の status は変えない。
- 後へ回した点: Agent settings の Web 編集画面（API は提供済み）、data-integrity の verify script
  による claim / Run 不整合の検査。不整合は読み取り時に fail-closed で検出する。

### Slice 2 の実装状況

- 実装済み（server と MCP）: `POST /v1/agent-runs/{runId}/reports`、report row と comment・Run の
  `reportCount`・lease・audit・receipt の単一 transaction、artifact URL の検証、Web 用の
  `GET /api/teams/{teamId}/work-items/{workItemId}/agent-run-reports`、`report_progress` の構造化 field。
  Collaboration の comment 作成は、信頼できる呼び出し元の書き込み（co-write）を同じ transaction に
  含められる。co-write 付きの作成は既存 comment の replay で失敗を隠さず、呼び出し元が分類する。
- 実装済み（Web と配布）: Work Item と task の詳細で、report を保存した comment の下に kind、検証結果、
  成果物 link、変更ファイル数を chip で表示する（blocker と handoff は判断待ちとして強調）。chip は一覧
  API が返す新しい report（既定 100 件、約 1 MB まで）に限り、それより古い comment は本文だけを表示する。
  `docs/coding-agent-mcp.md` に Claude Code / Codex / Kiro の設定例を置き、`mcp.mjs` は Node.js でも
  起動できる単一ファイルとして、同梱ライセンス一覧と一緒に build する。GitHub Release への自動添付は、
  workflow の追加に別の権限が要るため次の変更で入れる。

### Slice 3 の実装状況

Slice 3 は 3 つの変更に分けて入れ、すべて実装済み。

- 実装済み（Agent settings、Ready、brief）: Agent settings に `readyStatusIds`（最大 50 件、重複不可）、
  Team の `brief`、`projectBriefs`（最大 20 Project）を追加した。brief はそれぞれ UTF-8 で 16 KiB まで、
  合計 128 KiB までとし、空白だけの brief は保存しない。保存は全体の置き換えで、省略した field は
  消える。保存前の row は新しい field を持たず、既定値（空の一覧と map）として読む。audit には
  `readyStatusIds` の変更と、brief の本文ではなく byte 数の変化を残す。Project brief は Team の Project に
  限り、読み取り（Web と Public API）では呼び出し元が閲覧できる Project の brief だけを返す。Web の保存では、
  編集者が閲覧できない Project の brief を受け付けず（`403`）、保存済みの値をそのまま残す。Team に属さない
  Project の brief は `400` とし、Team から外れた Project の保存済み brief は次の保存で消える。
  Public API の `AgentSettings` は閉じた response schema で property を追加できないため、Ready status と
  brief は新しい `GET /api/v1/agent-context` で返す。`AgentContext` は以後の Agent settings を追加できるよう
  閉じない object とし、client は知らない property を無視する。MCP はこの path がない古い server では既定値として動く。
  Run の start は `readyStatusIds` が空でなければ現在の status がその中にあることを確認し、なければ
  `409` と `not_ready` を返す。設定の revision は start の transaction で検査するため、並行した
  設定変更とも整合する。MCP の `get_next_task` は Ready でない候補を `skipped` の `not_ready` として除外し、
  `get_configuration` は `agentSettings.readyStatusIds` と `brief`（Team brief の後に設定 Project の
  brief を連結）を返す。`mukuroji://project/{projectId}/brief` resource も同じ内容を返し、
  `MUKUROJI_MCP_PROJECT_ID` を設定した MCP は別 Project の brief を `out_of_scope` で拒否する。
- 実装済み（受け入れ条件）: canonical Work Item の任意 field `acceptanceCriteria`（`{ id, text, satisfied }`、最大 20 件、
  `text` は前後の空白を除いて 1〜1,024 文字）。`id` は server が 32 桁の 16 進数で採番し、PATCH は一覧全体の置き換えで
  既存の条件を `id` で指す。空の一覧は属性を消し、保存前の row は属性を持たない。Web と Public API の PATCH で
  編集でき、`id` は読んだ一覧を指すため revision が古い PATCH は `409` とする。Agent Run に fence された Public PATCH は
  既存の条件の `satisfied` だけを変えられ、それ以外は `403`（`AcceptanceCriteriaChangeForbidden`）とする。変更は Work Item
  の audit の field change に残る。Agent settings に `requireAcceptanceCriteria` と `acceptanceCriteriaFieldId` を追加し、
  受け入れ条件がない（代替 custom field の値も空の）Work Item の start を `not_ready` とする。MCP の `get_next_task` は
  同じ判定で候補を除外し、`get_task` は受け入れ条件を返す。`update_task` の `acceptanceCriteria: [{ id, satisfied }]` は
  Public PATCH の `acceptanceCriteriaMarks` として送り、server が保存済みの一覧に重ねる。印だけを idempotency の
  範囲に入れるため、応答を失った後の再送は、その間に一覧が変わっても replay になる。Public API の `WorkItem` は閉じた response schema のため条件を含めず、
  `GET /api/v1/work-items/{workItemId}/acceptance-criteria` が一覧と読み取り時の Work Item `revision` を返す。
  2 つの設定は `GET /api/v1/agent-context` に加える。MCP はこの path がない古い server では条件なしとして動く。
- 実装済み（Web 編集画面）: Task と Team Issue の詳細に受け入れ条件の section を置き、進捗（達成数 / 全体）と各条件の
  状態を表示する。編集では条件の追加、削除、上下の並べ替え、文言と達成状態の変更ができる。draft は詳細 form の hidden field
  で送るため、他の項目と同じ PATCH、同じ revision で保存する。空欄、1,024 文字超、21 件以上は保存前に該当行へ error を出す。
  受け入れ条件を含む Task の更新は undo の対象にしない。revision が変わった（保存の成功や `409` の後に読み直した）ときは、
  form の他の項目と同じく draft を捨てて最新の一覧を表示する。設定画面には Team ごとの Agent settings panel を置き、
  Ready status、受け入れ条件の必須化と代替 custom field、Team brief、Project brief を編集する。編集できるのは Team の設定を
  変更できる member に限り、`403` の場合は読み取り専用で表示する。読み込みに失敗したときは、空の設定ではなく再試行を出す。

### Slice 4 の実装状況

- 実装済み（server）: `GET /api/teams/{teamId}/agent-runs`。Team の閲覧権限を確認し、次の 3 つから
  候補の Work Item を集める。どの読み取りも上限を持ち、上限で止まった場合は応答の
  `activeRunsHasMore`、`finishedRunsHasMore`、`startedWorkItemsHasMore` で示す。黙って切り捨てない。
  - `ActiveRunIndex` の lease の早い順に最大 100 件。index は結果整合のため、各 Run を強整合で
    読み直し、`active` のものだけを使う。1 つの Work Item に `active` Run が 2 件あれば claim の
    不変条件が壊れているため、`503` で fail-closed にする。
  - 終了済み Run を最大 500 件評価し、直近 24 時間に終了した Run と、時期を問わず `failed` で終了した Run の
    Work Item を拾う。終了済み Run は
    run ID 順に保存され終了時刻の index がないため、Team の終了済み Run が 500 件を超えると完了 lane が
    欠けうる。その場合は `finishedRunsHasMore: true` を返す。
  - Work Item を更新の新しい順に最大 300 件評価し、閲覧できる `started` のものを拾う。status category の
    index はない。
- 候補の Work Item はそれぞれ強整合で読み直し、archive・削除済みと、閲覧できない Project のものを除く
  （`canAccessAssignedProject`）。`active` Run がなければ Work Item の Run 履歴から最新の 1 件を読む。
  「その後に新しい Run がない」はこの最新 1 件で判定する。読み取りは同時 10 件までとする。
- Run に report があれば、Work Item の最新 report を 1 件と、その comment を読む。tile の要約は report の
  kind、時刻、検証結果の件数、成果物の件数、変更ファイル数と、comment 本文から agent label を除いた
  先頭 256 文字である。本文は読み取り時に comment から取るため、編集・削除された comment の古い本文は
  board に残らない。削除済みなら本文の抜粋を返さない。
- `canRelease` は Work Item 詳細の Run 履歴と同じ規則（Run の開始者、Work Item の現在の担当者、または
  Team manager で、Work Item を更新できる member）で、`active` Run にだけ付ける。解放は既存の
  `POST /api/teams/{teamId}/agent-runs/{runId}/release` を使う。
- lane の判定は contracts の純関数 `classifyFactoryBoardItem` に置く。server はこれで lane に入らない
  Work Item を応答から除き、Web は応答の `generatedAt` を基準に同じ関数を適用する。lease 切れや 24 時間の
  経過による lane の移動は、次の再取得（focus、60 秒ごと、再読み込み操作）で反映される。server は lane を
  固定値として返さず、Web と同じ関数で判定するため、両者の判定は食い違わない。
  - 判断待ち: `active` Run の最新 report が `blocker` / `handoff`、または最新 Run が `paused` で終了し
    Work Item が `started`。`blocker` を出した後に lease が切れた Run は停滞より判断待ちを優先する。
  - 停滞 / 処理中: `active` Run の lease が切れているか。
  - 失敗: 最新 Run が `failed`。Work Item が完了・中止（`completed` / `canceled`）になるまでは期限なく残り、
    完了・中止の後は終了から 24 時間だけ出る。差し戻して `started` から外れた Work Item も残る。
  - 完了: 最新 Run が直近 24 時間に `completed`。
  - Run なし: 上のどれにも入らない `started` の Work Item（Run がない、または最新 Run が `released` など）。
- filter（runtime、assignee、Project）は Web で行う。応答は上の上限で有界なため、query parameter は
  設けない。
- 実装済み（Web）: Team の `/teams/{teamId}/factory` に Factory board を置き、サイドバーの Team view に
  入口を足した。lane は応答の `generatedAt` を基準に `classifyFactoryBoardItem` で分け、lease 残り時間も
  同じ時刻で表示する。端末の時計のずれで lane が server の判定と食い違わないためである。Run なしは
  処理中 lane の末尾に区切って出す。tile は Work Item title、agent 名と runtime、最新 report の kind・
  検証件数・本文の抜粋、lease 残り時間または終了時刻を表示し、進捗率は出さない。
- 再取得は focus 時、60 秒ごと、再読み込み操作で行う。board の読み取りは Work Item の Run パネル
  （30 秒）より重いため間隔を長くした。読み込み失敗は空の board ではなく error と再試行で示し、
  取得済みの board がある場合はそれを残したまま error を出す。上限に達した場合は欠けうることを示す。
- detail は既存の `GET .../agent-run-reports`（新しい 100 件）から選んだ Run の report を時系列で表示し、
  検証結果と成果物 link は Work Item の comment と同じ chip を使う。report ごとの本文は comment にあるため
  detail には最新 report の抜粋だけを出し、全文は「Work Item を開く」から読む。解放は Work Item 詳細と
  同じ確認と API を使い、`canRelease` の `active` Run にだけ出す。
- desktop は lane の横に detail を置き、phone は lane を縦に積み、tile を選ぶと detail に切り替わって
  「一覧に戻る」で元の tile に戻る。Storybook で 1440×900 と 390×844 を確認し、横方向の overflow がない
  ことを確かめた。
- 担当者は server が Cognito の profile から表示名とメールアドレスを読み、`assigneeName` と `assigneeEmail` として
  返す。読み取りは担当者ごとに 1 回、同時 10 件までとし、全体で 2 秒を超えたら残りを待たない。profile がない、
  読めない、または期限までに読めなかった場合も board は失敗させず、Web は表示名、メールアドレス、member ID の順に
  代わりを使う。読み取りの失敗は request の correlation ID、Team ID、error code だけを記録し、member を含みうる message は記録しない。filter の選択肢は
  表示名の順に並べ、同じ表示名の担当者には member ID を添える。

## 後続 Phase

- GitHub adapter を `ConnectorAdapter` 境界の後ろに実装し、report の `pull-request` artifact を
  external link と突き合わせて CI、レビュー、merge 状態を取り込む。
- Work Item に Gate（CI、bot review、人の承認）を持たせ、`complete` 遷移の server 検証に
  組み込む。既存の approval action を再利用する。
- stage 別 lead time、Run の成功 / 手戻り率、token 費用を analytics に追加する。
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
