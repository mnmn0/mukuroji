# 0061. Coding agent のトークン使用量を OTLP/HTTP JSON で受け取り、読み取り時に時刻で Run に割り当てる

- 状態: 提案
- 日付: 2026-11-22
- 関連: Issue #729, Issue #355, [ADR 0052](0052-personal-tokens-without-software-factory.md),
  [docs/software-factory.md](../software-factory.md), [docs/coding-agent-mcp.md](../coding-agent-mcp.md)

## 背景

Work Item（タスク）ごとに、coding agent が使ったトークン数と推定費用を知りたい。#355 は `finish_run` /
`report_progress` に `usage` を足し、agent が自己申告する案だった。しかし agent（model）は自分が使ったトークン数を
正確に知らず、申告させても推測値になる。

Claude Code は OpenTelemetry で、model への request ごとに `claude_code.api_request` event を出す。event には
入力・出力・prompt cache の読み取り・書き込みのトークン数、推定費用（`cost_usd`、新しい版は `cost_usd_micros`）、
model、時刻が入る。exporter は OTLP の `grpc`、`http/protobuf`、`http/json` を選べ、`OTEL_RESOURCE_ATTRIBUTES` で
任意の resource attribute を付けられる。ただし Claude Code は `OTEL_*` を MCP server などの子 process に渡さず、
MCP server からは telemetry の session ID も分からない。

Shinji の方針は「なるべく安く」。

## 決定

- **受け口**：Public API に `POST /api/v1/agent-telemetry/v1/logs` を追加する。OTLP/HTTP の JSON encoding
  （`Content-Type: application/json`）だけを受け、protobuf は `415` で断る。応答は OTLP の
  `ExportLogsServiceResponse` で、不正な usage record の件数を `partialSuccess.rejectedLogRecords` で返す。
  Software factory が off の deploy では、Agent Run の route と同じく `503` で断る。
- **認証**：新しい scope `agent-telemetry:write` を追加し、本人用 token の既定の scope に含める。既存の本人用
  token には付かないので、使う人は token を発行し直す。Workspace の API key にも付けられる。usage は
  credential の持ち主の member に記録する。read-only maintenance 中は書き込みとして断る。
- **読む値**：`claude_code.api_request`（`event.name` が `api_request`）の record だけを読み、読む attribute は
  トークン数 4 種、推定費用、model、時刻、`mukuroji.agent_instance` に限る。prompt、tool の入力、そのほかの
  attribute は読まずに捨てる。1 回の export は 2,000 record まで、7 日より古い event と 5 分より先の event は断る。
- **Run への割り当て**：Work Item key を `OTEL_RESOURCE_ATTRIBUTES` に入れる案は採らない。環境変数は Claude Code
  の起動時に固定されるが、1 つの session で複数のタスクを順に扱うからである。代わりに、MCP の
  `MUKUROJI_MCP_INSTANCE_ID` と同じ値を `mukuroji.agent_instance` resource attribute に入れてもらい、受け取った
  usage を member・instance hash・model・10 秒の bucket ごとに足し込む。Run の usage は読み取り時に、その Run の
  member と instance hash の bucket のうち、開始時刻の bucket から終了時刻の bucket の手前までを足して求める。
  続けて動いた 2 つの Run が同じ bucket を数えることはない。どの Run にも当たらない usage は member の行として
  残る。
- **保存**：Agent Runs table に置く。usage の行は partition `<directoryId>#agent-usage#member#<memberKey>`、
  sort key `<bucket 開始時刻>#<instance hash>#<model>` で、`UpdateItem` の `ADD` で足す。再送で二重に数えない
  よう、export の内容から作った ID の受領行（partition `...#agent-usage-batch#member#<memberKey>`）を同じ
  transaction で条件付き `Put` する。99 bucket ごとに 1 transaction とし、受領行も分ける。ID と bucket の区切りは、
  受信時刻で受け付けの窓から外れた event も含めた export の全 event から作り、再送までに event が 7 日を過ぎても
  同じ受領行に当たるようにする。table に TTL
  attribute `usageExpiresAt` を追加し、usage の行は 400 日、受領行は 2 日で消す。どの行も `workspaceId` を
  持つので、Workspace の削除・export の既存の対象に入る。
- **見せ方**：Web の Work Item の Run 一覧 API が、Run ごとの `usage` と、返した Run の合計 `usageTotal` を返す。
  トークン数は Work Item を見られる人に、推定費用は Team manager にだけ返す。1 Run あたり、その instance の
  2,000 bucket まで読む。同じ member の別 instance の行も同じ partition にあるため、読む行は 10,000 行までとし、
  どちらかで止まったら `hasMore` で知らせる。

## 検討した選択肢

- agent の自己申告（#355 の元の案）：受け口が要らず MCP だけで済むが、値が推測になる。却下。
- OTel collector（ADOT）を ECS などで常駐させ、CloudWatch や S3 に送る：OTLP の全 encoding を受けられるが、
  常駐の費用が月数ドル以上かかり、Run との突き合わせは結局 mukuroji 側に要る。却下。
- CloudWatch の OTLP endpoint に直接送る：受け口を作らずに済むが、client に SigV4 の AWS credential が要り、
  member ごとの認証・Run への割り当てができない。却下。
- metrics（`claude_code.token.usage`）を受ける：request 数は減るが、export の間隔（既定 60 秒）より細かい時刻が
  分からず、Run の境目で割り当てを誤る。logs の event は request ごとの時刻を持つ。logs を採る。
- 受信時に Run を探して Run の行に足す：読み取りは軽くなるが、Run は Team ごとの partition にあり、token からは
  Team が分からない。member の active Run を Workspace 全体から引く index が新たに要る。読み取り時の割り当てなら
  Run の書き込みと transaction を変えずに済む。却下。
- 1 分の bucket：行は減るが、Run の終わりの最大 1 分ぶんが割り当てから漏れる。10 秒にした。

## 結果

- Claude Code の設定（`CLAUDE_CODE_ENABLE_TELEMETRY=1`、`OTEL_LOGS_EXPORTER=otlp`、
  `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json`、endpoint、header、resource attribute）をすると、MCP で着手した
  Run にトークン数と推定費用が積み上がる。手順は `docs/coding-agent-mcp.md` に書く。
- 同じ instance ID で同時に 2 つの session を動かし、それぞれ別のタスクの Run を持つと、その間の usage は両方の
  Run に数えられる。同時に動かすときは session ごとに instance ID を分ける。
- 割り当ては agent の端末の時計で記録された event 時刻と、server の時計の Run の開始・終了を比べる。時計がずれると、
  境目の数秒から数十秒ぶんが前後の Run に入るか、どの Run にも入らない。開始と終了が同じ 10 秒の bucket に入る
  ごく短い Run には usage が付かない。
- 推定費用は Claude Code の見積もりで、請求額とは一致しない（subscription の利用でも値は出る）。
- 費用は、同時 10 session・60 秒間隔の export で月 $1 未満の見込み（Lambda の起動と DynamoDB の書き込みが主）。
- Factory analytics の期間サマリーも、期間内に終わった Run（新しい順に最大 300 件）の usage を同じ割り当てで足し、
  合計・Project 別・トークンの多い Work Item 上位 10 件を返す。Run ごとに usage を読むため、1 回の analytics で
  usage の Query が最大 300 回増える。
- Web の接続画面は、Claude Code に instance ID を入力すると MCP の `MUKUROJI_MCP_INSTANCE_ID` と Claude Code の
  OpenTelemetry 設定を同じ値で作る。instance ID を変えると、着手中の Run は別 instance の Run として扱われる。
- Codex / Kiro の telemetry は後続とする（#729）。Codex は token 数を出すが、resource attribute の指定、header の
  環境変数展開、attribute 名が公開資料の間で一致せず、割り当てと token の扱いを確かめられない。
- 更新した文書：`docs/coding-agent-mcp.md`、`docs/guide/coding-agent.md`、`docs/software-factory.md`、
  `docs/public-api.md`、`CHANGELOG.md`。
