# coding agent の telemetry 分析ストア（S3 + Athena）

coding agent（今は Claude Code）から受けた OpenTelemetry の event と、Agent Run・Work Item の値を S3 に Parquet で残し、
Athena の SQL で後から自由に集計できるようにする仕組みです。決めた理由は [ADR 0118](adr/0118-agent-telemetry-analytics-store.md)。
画面で見られる集計（Run の所要時間の内訳、Factory analytics の比較）は [ADR 0117](adr/0117-agent-run-time-breakdown-and-peer-comparison.md)
で、こちらはその元の event を残して、軸を後から選べるようにするものです。

## 有効にする

CDK context `mukuroji:agentAnalytics=true` で deploy します。`mukuroji:softwareFactory=true` も必要です
（[`cdk/README.md`](../cdk/README.md#optional-modules)）。作られるもの：

- S3 bucket `AgentAnalyticsBucket`（非公開、SSE-S3、data は 400 日、Firehose の失敗分は 30 日、Athena の結果は 7 日で削除）
- Glue database `<stack 名>_agent_analytics`（例：`mukuroji_agent_analytics`）と table `agent_events`・`agent_runs`・`agent_work_items`
- Firehose stream 3 本（Direct PUT、15 分か 64 MB ごとに Parquet で書く）
- Athena workgroup `<stack 名>-agent-analytics`（例：`mukuroji-agent-analytics`）。query ごとに 1 GiB を超える scan は止まります

off のときは API も job も何も送りません。

## 保存するもの・しないもの

保存するのは、ADR 0061・0117 で受け口が読む allowlist の値だけです。prompt、tool の入出力（Bash の command など）、
error の本文、生の session ID・instance ID・member ID・Workspace ID は保存しません。

| table | 行 | 主な列 |
| --- | --- | --- |
| `agent_events` | 受けた event 1 件 | `event_id`、`occurred_at_ms`、`event_name`（`api_request`・`api_error`・`tool_result`・`tool_decision`・`user_prompt`）、`member_key`、`instance_hash`、`session_hash`、`sequence`、`model`、トークン 4 種、`cost_micro_usd`、`duration_ms`、`tool_kind`（`builtin`・`mcp`・`skill`）、`tool_name`、`success`、`decided_by_person` |
| `agent_runs` | Run の開始時（`record_kind = 'started'`）と日次（`'daily'`） | `run_id`、`recorded_at_ms`、`team_id`、`work_item_id`、`instance_hash`、`runtime`、`started_at_ms`、`member_key`・`project_id`・`work_item_type_id`・`planned_effort_minutes`・`size_band`・`priority`・`compare_fields_json`（`started` だけ）、`state`・`outcome`・`finished_at_ms`（`daily` だけ） |
| `agent_work_items` | 日次の Work Item の値 | `team_id`、`work_item_id`、`exported_at_ms`、`status_category`、`project_id`、`work_item_type_id`、`planned_effort_minutes`、`size_band`、`remaining_effort_minutes`、`priority`、`actual_start_date`、`actual_end_date`、`archived` |

- `workspace_key` は Workspace ID の SHA-256（小文字 16 進）、`dt` は受信日（UTC、`yyyy-MM-dd`）で、どちらも partition です。
- `member_key` は member ID の HMAC（`MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY`）で、同じ環境の同じ人なら同じ値になります。
- `size_band` は `up-to-2h`・`up-to-1d`・`up-to-3d`・`over-3d`・`none`（見積もりなし）。
- `compare_fields_json` は Run 開始時の選択式・複数選択・数値・はい/いいえの custom field の値で、field ID を key にした JSON です。
- 再送された export は同じ `event_id` で二重に入ることがあります。集計では `event_id` で 1 件にします。
- Run と Work Item は日ごとに新しい行が増えます。最新の値は `recorded_at_ms`・`exported_at_ms` の一番新しい行です。
- event が Athena で見えるまで最大 15 分、Run の終了や Work Item の完了は 1 日以内に届きます。

## query を書く

Athena の console で workgroup を選んで書きます。`workspace_key` を必ず指定してください（指定しない query は partition を
探せずに失敗します）。Workspace ID から次のように求めます。

```sql
SELECT lower(to_hex(sha256(to_utf8('<Workspace ID>')))) AS workspace_key;
```

下の例は `<key>` をその値に、期間を見たい日に置き換えて使います。

### 重複を除いた event と、最新の Run

```sql
WITH events AS (
  SELECT * FROM (
    SELECT e.*, row_number() OVER (PARTITION BY event_id ORDER BY received_at_ms) AS n
    FROM agent_events e
    WHERE workspace_key = '<key>' AND dt BETWEEN '2026-12-01' AND '2026-12-31'
  ) WHERE n = 1
),
started AS (
  SELECT * FROM agent_runs
  WHERE workspace_key = '<key>' AND record_kind = 'started' AND dt BETWEEN '2026-11-01' AND '2026-12-31'
),
latest AS (
  SELECT * FROM (
    SELECT r.*, row_number() OVER (PARTITION BY run_id ORDER BY recorded_at_ms DESC) AS n
    FROM agent_runs r
    WHERE workspace_key = '<key>' AND record_kind = 'daily' AND dt BETWEEN '2026-11-01' AND '2027-01-31'
  ) WHERE n = 1
),
runs AS (
  SELECT s.run_id, s.team_id, s.work_item_id, s.member_key, s.instance_hash, s.runtime,
         s.work_item_type_id, s.size_band, s.compare_fields_json,
         s.started_at_ms, coalesce(l.finished_at_ms, s.started_at_ms + 86400000) AS until_ms, l.outcome
  FROM started s LEFT JOIN latest l ON l.run_id = s.run_id
)
SELECT ... -- 下の例の本体
```

以下の例は、この `events`・`runs` を前に置いた形で書きます。event は「同じ人・同じ instance で、Run の開始から終了までに
起きたもの」をその Run に割り当てます（画面の集計と同じ規則です）。

### Work Item ごとの時間とトークン

```sql
SELECT r.team_id, r.work_item_id,
       count(DISTINCT r.run_id) AS runs,
       sum(e.input_tokens + e.output_tokens + e.cache_read_tokens + e.cache_creation_tokens) AS tokens,
       sum(CASE WHEN e.event_name = 'api_request' THEN e.duration_ms END) / 60000.0 AS ai_minutes,
       sum(CASE WHEN e.event_name = 'tool_result' THEN e.duration_ms END) / 60000.0 AS tool_minutes
FROM runs r
JOIN events e ON e.member_key = r.member_key AND e.instance_hash = r.instance_hash
             AND e.occurred_at_ms >= r.started_at_ms AND e.occurred_at_ms < r.until_ms
GROUP BY 1, 2
ORDER BY tokens DESC
LIMIT 50;
```

### 同じ種類・規模なのに時間がかかったタスク

```sql
WITH per_item AS (
  SELECT r.work_item_type_id, r.size_band, r.work_item_id,
         sum(r.until_ms - r.started_at_ms) / 60000.0 AS run_minutes
  FROM runs r
  WHERE r.size_band <> 'none'
  GROUP BY 1, 2, 3
),
groups AS (
  SELECT work_item_type_id, size_band, approx_percentile(run_minutes, 0.5) AS median_minutes, count(*) AS items
  FROM per_item GROUP BY 1, 2
)
SELECT p.*, g.median_minutes, p.run_minutes / g.median_minutes AS ratio
FROM per_item p JOIN groups g USING (work_item_type_id, size_band)
WHERE g.items >= 3 AND p.run_minutes >= 2 * g.median_minutes
ORDER BY ratio DESC;
```

規模の代わりに custom field で分けるときは、`size_band` を `json_extract_scalar(r.compare_fields_json, '$["<field ID>"]')` に替えます。

### tool・MCP・skill ごとの時間

```sql
SELECT tool_kind, tool_name, count(*) AS calls,
       sum(CASE WHEN success = false THEN 1 ELSE 0 END) AS failures,
       sum(duration_ms) / 60000.0 AS minutes,
       approx_percentile(duration_ms, 0.9) AS p90_ms
FROM events
WHERE event_name = 'tool_result'
GROUP BY 1, 2
ORDER BY minutes DESC
LIMIT 30;
```

### model ごとのトークンと推定費用

```sql
SELECT model, count(*) AS requests,
       sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
       sum(cache_read_tokens) AS cache_read_tokens, sum(cache_creation_tokens) AS cache_creation_tokens,
       sum(cost_micro_usd) / 1e6 AS cost_usd,
       sum(duration_ms) / 60000.0 AS ai_minutes
FROM events
WHERE event_name = 'api_request'
GROUP BY 1
ORDER BY cost_usd DESC;
```

## 費用

ap-northeast-1 の料金（2026-11-28 時点）で、Firehose は受けた量 1 GB あたり Direct PUT $0.036・Parquet 変換 $0.022・
dynamic partitioning $0.032、Athena は scan 1 TB あたり $5（query ごとに最小 10 MB）です。50 人が 1 日 8 時間使って
月 9 GB 前後なら、合わせて月 $1 前後の見込みです。待機中は S3 の保存分だけかかります。
