# 0035. X-Ray tracing を既定で止め、AI の alarm を AI 設定時だけ作る

- 状態: 提案
- 日付: 2026-11-21
- 関連: Issue #436、PR #658、[cdk/README.md の費用の目安](../../cdk/README.md#費用の目安と予算-alert)、[docs/operational-readiness.md](../operational-readiness.md)

## 背景

2026-11-21 に既定構成の費用を見積もり直したところ、X-Ray active tracing が毎分の scheduled job だけで月約
4.3 万 trace を使い、50 人規模では API の trace と合わせて月約 70 万 trace（約 $3）になっていた。社内利用の
単一 Workspace では、trace は障害調査のときだけあれば足りる。調査は API log の `invocationId` と時間帯から
Lambda log を辿る手順が既にある。

AI の alarm 10 個（provider の失敗・throttle・不正出力・遅延・usage 欠落と、AI observability worker の 5 個）は、
AI を設定していない stack でも作られ、月 $1 かかっていた。AI 未設定では metric も stream も動かないので、
これらの alarm は鳴ることがない。

Shinji の方針は「なるべく安く」。

## 決定

- **X-Ray**：stack parameter `LambdaTracingMode`（`PassThrough` | `Active`、既定 `PassThrough`）を追加する。
  コードでは各 Lambda が `lambda.Tracing.ACTIVE` を宣言したままにし、stack の aspect がそれを parameter の値に
  置き換える。restore drill の state machine の tracing flag も `LambdaTracingActive` condition に従う。
  X-Ray への書き込み権限は execution role に残し、切り替えで IAM が変わらないようにする。
- **AI の alarm**：10 個の alarm に CloudFormation の condition `AiAssistanceConfigured` を付け、AI を設定した
  stack にだけ作る。metric を出す worker と DLQ はデータ保持のため従来どおり作る。

## 検討した選択肢

- X-Ray を CDK context（`-c mukuroji:xray=true`）で切り替える：任意 module と同じ形だが、運用者が調査のために
  有効にするにはコードを持つ環境で synth し直す必要がある。parameter なら同じ template のまま切り替えられる。
- X-Ray の sampling rule で率を下げる：Lambda の既定 rule（1 秒 1 request + 5%）を下げる custom rule は
  account 全体に効き、毎分の job の trace も残るため、止めるより節約が小さい。
- X-Ray の IAM 権限も一緒に外す：最小権限にはなるが、切り替えのたびに role の policy が変わり、
  API role の inline policy 上限に近い現状では差分が読みにくくなる。

## 結果

- 既定構成で X-Ray の費用が $0 になり、alarm が 33 個から 23 個に減る（月 −$1）。
- 既定では trace がないため、API log の `traceId` から X-Ray を引く調査はできない。必要なときは
  `LambdaTracingMode=Active` で deploy してから再現させる。
- AI を後から設定すると alarm 10 個が作られる。AI の provider 設定の方式を変える場合は、この condition も
  同じ「AI が有効か」の判定に揃える。
- 更新した文書：`cdk/README.md`、`docs/operational-readiness.md`。
