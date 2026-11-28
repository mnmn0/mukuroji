# 0118. coding agent の telemetry event を S3 に Parquet で残し、Athena で後から自由に集計する

- 状態: 提案
- 日付: 2026-11-28
- 関連: Issue #838, Issue #834, [ADR 0061](0061-agent-token-usage-over-otlp.md),
  [ADR 0117](0117-agent-run-time-breakdown-and-peer-comparison.md), [ADR 0029](0029-software-factory-deploy-switch.md)

## 背景

ADR 0117 で、tool・待ち時間・model ごとの時間を DynamoDB に足し込み、決まった切り口（Run、Work Item、Factory analytics の
「種類 × 規模」比較）で見せるようにした。Shinji は「同じタスクレベルなのに差が出ている」ことを後から分析できる基盤を
求めている。比べたい軸（custom field、model、runtime、担当、tool の組み合わせ）は後から変わるので、決まった集計だけでは
足りない。event を1件ずつ DynamoDB に置くと行数と書き込みが event 数に比例して費用が増える（ADR 0117 で却下）。

費用は「なるべく安く」が方針で、待機中に費用がかからないことを重視する。保存してよいのは ADR 0061・0117 の allowlist の
値だけで、prompt、tool の入出力、error の本文は保存しない。

2026-11-28 に AWS Pricing API で確かめた ap-northeast-1 の料金：

| 項目 | 料金 |
| --- | --- |
| Amazon Data Firehose Direct PUT（最初の 500 TB） | $0.036 / GB（record ごとに 5 KB 単位に切り上げ） |
| Firehose の Parquet 変換 | $0.022 / GB |
| Firehose の dynamic partitioning | $0.032 / GB、$0.008 / 1,000 object、JQ 処理 $0.112 / 時間 |
| Athena | $5 / TB scan（query ごとに最小 10 MB） |
| Glue Data Catalog | 100 万 object まで無料、request は月 100 万回まで無料 |
| S3 Standard | $0.025 / GB 月 |

## 決定

- **保存先**：CDK の任意 module `mukuroji:agentAnalytics`（`softwareFactory` が前提。既定は off）で、専用の S3 bucket、
  Glue database、table ごとの Firehose stream（Direct PUT）、Athena workgroup を作る。deploy はこの PR では行わない。
- **table**：3 つに分ける。
  - `agent_events`：OTLP logs の受け口が受けた event を1件1行で残す。`api_request`（model、トークン 4 種、推定費用、
    `duration_ms`）、`api_error`、`tool_result`（tool の種類と名前、成否、`duration_ms`）、`tool_decision`（人が判断したか）、
    `user_prompt`（時刻だけ）。session は ADR 0117 と同じ hash、instance ID も hash だけ。
  - `agent_runs`：Run の開始・引き継ぎ・再開の時点で、比較の軸を写した `started` 行（種類、Project、見積もり、規模、優先度、
    選択式・複数選択・数値・はい/いいえの custom field の値を JSON で）。日次の job が Run の状態（state、outcome、終了時刻）を
    `daily` 行として足す。
  - `agent_work_items`：日次の job が、対象 Run の Work Item の今の値（状態の分類、見積もり、残り、実績の開始・終了日、
    archive）を書く。
- **partition**：`agent-analytics/<table>/workspace_key=<hash>/dt=<UTC の受信日>/`。`workspace_key` は Workspace ID の
  SHA-256（小文字 16 進）にする。個人 Workspace の ID はメールアドレスを含むことがあり、S3 の key に生で載せない。
  Firehose の dynamic partitioning（JQ で `workspace_key` を取り出す）と Parquet 変換（SNAPPY）で書き、Glue table は
  partition projection（`workspace_key` は `injected`、`dt` は日付）で探す。query は必ず `workspace_key` を指定する。
- **人の識別**：member ID は保存しない。監査 ID の HMAC に使う環境ごとの固定 key（`MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY`）で
  `HMAC-SHA256("agent-analytics-member\0<workspace>\0<member>")` の先頭 32 桁を `member_key` にする。key がない環境（scheduled-jobs Lambda を含む）では
  member の列を空にする。日次の行には member の列がなく、`started` 行で結ぶ。
- **Run への割り当て**：受信時には割り当てない。Athena で `member_key`・`instance_hash` と Run の開始〜終了の時刻で
  `agent_events` と `agent_runs` を結ぶ。ADR 0061 と同じ規則を SQL で書ける。
- **書き込み**：
  - 受け口は usage・activity の保存（ADR 0061・0117）が終わってから、重複でない export だけを送る。1 回の export の行を
    改行区切りの JSON 1 record（最大 900 KiB、500 行まで。de-aggregation の上限）にまとめ、Firehose の record de-aggregation で行に戻す。Firehose は record ごとに
    5 KB 単位で課金するので、行ごとに送るより安い。`event_id` は export の ID と順番から作り、再送された export を Athena で
    除ける。
  - 送信の失敗は log に残して捨て、API の応答は変えない（best-effort）。Firehose が断った record は 2 回まで送り直す。
  - Run の開始時は、その Run の ID を Agent Runs table の global partition `agent-analytics-watch#<UTC 日付>` に置く
    （ID だけ、TTL 32 日）。日次の job（scheduled-jobs Lambda、UTC 0 時、`agent-run-triage` の停止 scope を共有）が過去 30 日分の
    ID を読み、閉鎖中・閉鎖済みの Workspace を除いて、Run と Work Item の今の値を書く。上限を置かず、500 件ずつの page を読むたびに書き出すので、メモリは 1 page 分で済み、記録した Run を取りこぼさない。
- **保持と workgroup**：data は 400 日（ADR 0061 の usage と同じ）、Firehose の失敗 object は 30 日、Athena の結果は 7 日で消える。
  workgroup は query ごとの scan 上限 1 GiB を強制し、結果を SSE-S3 で暗号化する。
- **Workspace の閉鎖とエクスポート**：analytics bucket を tenant lifecycle の file namespace に 3 つ（table ごとの
  `workspace_key=<hash>/`）加え、エクスポートでは読み、閉鎖では消し、検証では残っていないことを確かめる。
  Firehose が変換できなかった record は Workspace で分けられない共有の `agent-analytics-errors/` に入り、どの Workspace の行も
  含みうるので、閉鎖ではこの prefix を全部消し、エクスポートには入れない（失敗 object は 30 日で消える調査用の写しで、失っても
  data は欠けない）。analytics bucket がある環境では、閉鎖の最初のエクスポートを要求から 30 分待つ。Firehose は最大 900 秒
  buffer し、その 1.5 倍まで遅れて届け、dynamic partitioning を 300 秒送り直すので、閉鎖前に受けた record は 27.5 分以内に S3 に
  届く。

## 検討した選択肢

- event を DynamoDB に1件ずつ置く：今の query で読めるが、書き込みが event 数に比例し、自由な集計には向かない。却下。
- Kinesis Data Streams や Lambda で Parquet を作る：shard 時間や Lambda の常時費用がかかり、変換を自前で持つ。却下。
- Glue crawler や `MSCK REPAIR` で partition を足す：crawler の実行費用と遅れが出る。partition projection なら要らない。却下。
- Workspace ID をそのまま partition にする：個人 Workspace のメールアドレスが S3 の key と Athena の結果に出る。hash にした。
- Run を受信時に割り当てて event に `run_id` を付ける：受信ごとに Run の読み取りが要り、後から Run の範囲が変わると
  直せない。Athena の join にした。
- Work Item の変更を都度書き出す：Work Item の更新経路すべてに手を入れることになる。日次の書き出しで、開始後の完了や
  見積もりの変更は1日以内に届く。

## 結果

- 50 人・1 日 8 時間の利用で月 9 GB 前後の JSON を受けると見込み、Firehose・S3・Athena を合わせて月 $1 前後。待機中は
  S3 の保存分だけになる。
- 分析者は Athena の workgroup で SQL を書く。例は [`docs/agent-telemetry-analytics.md`](../agent-telemetry-analytics.md)。
- Firehose の buffer（15 分・64 MB）のため、event が Athena で見えるまで最大 15 分ほどかかる。Run と Work Item の終わりの値は
  1 日以内に届く。
- `dt` は受信日なので、日をまたぐ Run は 2 日分の partition を読む。
- 更新した文書：`docs/agent-telemetry-analytics.md`、`docs/guide/coding-agent.md`、`cdk/README.md`。
