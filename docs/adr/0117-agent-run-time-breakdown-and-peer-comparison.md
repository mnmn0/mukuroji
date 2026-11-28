# 0117. coding agent の所要時間を同じ OTLP logs から tool・待ち時間別に足し込み、同じ種類・規模のタスク同士で比べる

- 状態: 提案
- 日付: 2026-11-28
- 関連: Issue #834, Issue #729, Issue #838, Issue #835, [ADR 0061](0061-agent-token-usage-over-otlp.md),
  [ADR 0108](0108-analytics-agent-usage-metrics.md)

## 背景

ADR 0061 で Claude Code の OpenTelemetry logs を `POST /api/v1/agent-telemetry/v1/logs` で受け、`claude_code.api_request`
のトークン数・推定費用・model だけを Run に割り当てて見せた。Shinji は DMM の発表（OTel で session 単位に agent の
挙動と実行時間を集計）を見て、「何に時間がかかっているか」（AI の応答、Bash などの tool、どの MCP・skill、権限の
承認待ち、人の次の指示待ち）を Run・Work Item・Project ごとに見たい、同じレベルのタスクなのに差が出ているものを
後から見つけたい、使っている model も軸にしたい、と求めた。

Claude Code は同じ logs export で、`api_request` の `duration_ms`、`tool_result`（`tool_name`、`success`、
`duration_ms`、MCP server・tool 名と skill 名は `OTEL_LOG_TOOL_DETAILS=1` のとき `tool_parameters` の中）、
`tool_decision`（`source` が `user_temporary` などなら人が判断した）、`user_prompt` と、全 event に `session.id`・
`event.sequence` を送る。承認待ちの時間そのものは trace の span（`claude_code.tool.blocked_on_user`、beta）にしかなく、
logs の event には時間の attribute がない。export は既定で 5 秒ごとなので、人の待ちの前後の event はたいてい別の export に入る。

mukuroji には story point や難易度の専用 field はなく、見積もり（`schedule.plannedEffortMinutes`）・種類・優先度・
custom field がある。費用は「なるべく安く」が方針。

## 決定

- **読む event と attribute**：今の受け口で `tool_result`・`tool_decision`・`user_prompt`・`api_error` も読む。
  allowlist に `duration_ms`、`session.id`、`event.sequence`、`tool_name`、`success`、`source`、`decision_source`、
  `tool_parameters`、`mcp_server_name`、`mcp_tool_name`、`skill_name` を足す。`tool_parameters` は 16 KiB までの JSON
  として parse し、`mcp_server_name`・`mcp_tool_name`・`skill_name` だけを取り出して残りは捨てる（Bash の command
  などは保存しない）。prompt、tool の入出力、error の本文は今と同じく読まない。`session.id` は SHA-256 の hash に
  してから使い、生の値は保存しない。
- **tool の分け方**：`mcp__<server>__<tool>` か `tool_parameters` の MCP 名があるものは `mcp` の `<server>/<tool>`、
  `Skill` で skill 名があるものは `skill` の skill 名、それ以外は `builtin` の tool 名にする。tool details を
  送っていない利用者定義の MCP（`mcp_tool`）は `mcp` の `unknown/unknown`、skill 名のない `Skill` は `builtin` の
  `Skill` に入る。
- **model の時間**：`api_request` の `duration_ms` を、ADR 0061 の usage 行（member・instance・model・10 秒 bucket）に
  `durationMs` として `ADD` で足す。既存の行は 0 と読む。API の `AgentRunUsage` に `aiDurationMs` と model ごとの
  `byModel`（トークン 4 種、request 数、時間、manager には推定費用）を足す。main agent と sub-agent が別 model を
  使うため、Run 単位でなく request 単位で数える。
- **tool と待ち時間の保存**：Agent Runs table に partition `<directoryId>#agent-activity#member#<memberKey>`、sort key
  `<bucket 開始時刻>#<instance hash>#<tool|wait>#<name>` の行を置き、`count`・`durationMs`・`failureCount` を `ADD` で
  足す。tool の name は `<kind>:<名前>`、待ちは `approval` と `prompt`。1 回の export の中で行ごとにまとめてから書くので、
  書き込みは「export × 行」で、event 数には比例しない。再送対策は usage と同じく、export の全 event から作った ID の
  受領行（usage と同じ partition に `activity#<ID>#<chunk>`）を 99 行ごとの transaction で条件付き `Put` する。TTL は
  usage と同じ 400 日。Run への割り当ても usage と同じ範囲（開始 bucket から終了 bucket の手前）を読み取り時に求める。
- **待ち時間の推定**：session ごとに最後の event 時刻を cursor 行（partition `<directoryId>#agent-session#member#<memberKey>`、
  key `<instance hash>#<session hash>`、TTL 8 日）に持つ。export を受けるたびに、その export の session の cursor を
  `BatchGetItem` で読み、event を時刻（同じ時刻は `event.sequence`）順に並べて、`user_prompt` と人が判断した
  `tool_decision` に「同じ session の直前の event からの間隔」を待ち時間として足す。直前の event は同じ export の前の
  event、なければ cursor。間隔が 2 時間を超えるものは席を外していたとみなし、待ちにも作業にも数えない。最初の prompt
  など直前の event がないものも数えない。保存後に cursor を「今より新しいときだけ」の条件付き `UpdateItem` で進める。
  `api_request` と `tool_result` の時刻は完了時と見なす（公式資料は start か completion かを書いていないため、#454 の
  実機で確かめる）。
- **見せ方**：Run 一覧 API が Run ごとの `activity`（tool の回数・時間・失敗、tool 別の上位 30 件、承認待ち、指示待ち）と
  合計 `activityTotal` を返す。Factory analytics は `activity`（model 時間、tool・待ちの合計、時間の長い tool 上位 10 件、
  model と tool の時間が「作業時間 + 待ち時間」に占める割合）と `comparison` を返す。
- **同じレベルのタスクの比較**：Factory analytics の対象 Run（期間内に終わった新しい順 300 件）を Work Item ごとにまとめ、
  「種類 × 規模」で group にする。規模は既定で見積もりの段階（2 時間以下、1 日 = 8 時間以下、3 日以下、それより上、
  見積もりなし）、query の `compareFieldId` で custom field の値に替えられる。group ごとに Run の所要分（開始〜終了の合計）・
  トークン・推定費用（manager のみ）の中央値と、model ごとの中央値を返す。3 件以上の group で、所要分かトークンが中央値の
  2 倍以上の Work Item を外れ値として、比率・model・runtime・担当・Run 数・手戻り回数・tool と待ちの時間付きで最大 20 件
  返す。値のない Work Item は `none` の group（`missingValue: true` を付け、ID が `none` の選択肢とは分ける）として件数だけ数える。
- **Analytics の model 軸**：`AnalyticsGroupBy` に `model` を足す。`agent-tokens` と `agent-cost` だけが受け付け、Run の
  トークン・費用を request の model ごとに分けて group にする。他の metric では validation error。新しい metric は足さない。

## 検討した選択肢

- trace（span）を受けて waterfall を出す：承認待ちが正確に分かるが、Claude Code の trace 送信は beta で、受け口と保存が
  別に要る。後回し（#834 の範囲外）。
- 待ち時間を export の中だけで測る：cursor の読み書きが要らないが、export は 5〜60 秒ごとで、人の待ちの前後はほぼ必ず別の
  export に入るため、待ちをほとんど拾えない。却下。
- 待ち時間を読み取り時に bucket の並びから推定する：書き込みは増えないが、10 秒 bucket の粒度で承認待ち（数秒〜数十秒）が
  埋もれる。却下。
- event を1件ずつ保存して読み取り時に集計する：自由に切れるが、行数と書き込みが event 数に比例して費用が増える。
  自由な切り口は #838（S3 + Athena）で扱う。却下。
- 比較の軸を Workspace の設定として保存する：画面ごとに同じ軸になるが、設定の保存先と権限が増える。比べたい軸は見る人と
  場面で変わるため、query parameter にした。#838 の書き出しでは custom field の値をそのまま残し、Athena で好きな軸を選ぶ。

## 結果

- 送る側の設定は今のままで、tool の時間と待ち時間が積み上がる。MCP server 名と skill 名は Claude Code に
  `OTEL_LOG_TOOL_DETAILS=1` を足したときだけ分かれる。この設定は Bash の command などの tool 入力も export に載せるが、
  mukuroji は名前だけを取り出して捨てる。
- 書き込みは 1 export あたり activity の transaction が 1 回（99 行ごと）、cursor の読み 1 回と更新が session ごとに 1 回増える。
  同時 10 session・60 秒間隔なら月 $1 未満の見込み（DynamoDB の on-demand 書き込みが主）。
- 待ち時間は推定で、同じ session で sub-agent が並行して動いている間の承認は、他の agent の event からの間隔になり短めに出る。
  席を外した 2 時間超の間隔は数えない。
- Factory analytics は Run ごとに activity の Query が 1 回増え、最大 300 回。
- 更新した文書：`docs/coding-agent-mcp.md`、`docs/guide/coding-agent.md`、`docs/software-factory.md`、`docs/analytics.md`。
