# 0007. AuditEvents stream の reader を 2 つに保ち、worker の secret を Secrets Manager から読む

- 状態: 提案
- 日付: 2026-11-19
- 関連: Issue #491, Issue #494, PR #552

## 背景

`AuditEventsTable` の DynamoDB stream には Lambda の event source mapping が 3 つ付いていた
（`CollaborationProjectionFunction`、`AutomationEventFunction`、`TenantOperationFunction`）。
DynamoDB Streams は同じ shard を同時に読む reader を 2 つまでとしており、3 つ目があると
`GetRecords` が throttle され、iterator age が伸びる可能性がある（#491）。

同じ時期、4 つの worker Lambda が NoEcho の CloudFormation parameter を `Ref` で環境変数に
持っていた。値は `lambda:GetFunctionConfiguration` を持つ principal から読める（#494）。
API Lambda はすでに Secrets Manager 経由で読んでいる。

## 決定

1. `AuditEventsTable` の stream reader は `CollaborationProjectionFunction`（audit projection）と
   `AutomationEventFunction` の 2 つに限る。監査 event 1 件ごとのテナント保持期間の反映
   （`reconcileAuditEventRetention`）は `TenantOperationFunction` から audit projection の fan-out に
   移す。監査 event に反応する処理を今後足すときも、新しい mapping ではなく fan-out に加える。
   2 つの reader には `IteratorAge` alarm（Maximum が 15 分以上）を付ける。
2. worker には NoEcho の値を渡さず、値を持つ Secrets Manager secret の ARN を
   `<NAME>_SECRET_ARN` で渡す。worker は cold start で読み、`<NAME>` に戻す。deployed Lambda で
   平文の値を受け取ったら起動を拒否する。secret は parameter ごとに 1 つで、`RETAIN` にする。
   secret の ARN は rotation で変わらないため、`ApiRuntimeConfigurationRevision` を worker の
   `MUKUROJI_WORKER_SECRET_REVISION` に渡し、rotation の deploy で warm な実行環境を入れ替える。

## 検討した選択肢

- 監査 stream を 1 つの consumer にまとめ、SNS / SQS や EventBridge Pipes で fan-out する:
  reader 数の問題は根本的に消えるが、resource と遅延が増え、順序も失われる。今の負荷では過剰。
- `AuditEventsTable` を Kinesis Data Streams for DynamoDB に移す: reader 数の制約はなくなるが、
  shard 時間の課金（1 shard で月 $10 前後）が「なるべく安く」の方針に合わない。
- 保持期間の反映を audit projection ではなく automation 側に移す: automation の IAM が広く、
  そこへ監査 table の更新権限を足すより、projection に限定した権限を足す方が狭い。
- worker の secret を 1 つの JSON secret にまとめる: secret の数（費用）は減るが、worker ごとに
  必要な鍵だけを読ませる最小権限が崩れる。

## 結果

- stream の reader が推奨上限内に収まり、遅延は `IteratorAge` alarm で検知できる。
- 保持期間の反映の失敗時の扱いは projection に揃う（retry 3 回、`CollaborationProjectionDlq`）。
  以前の `TenantOperationFunction` は retry 10 回だった。反映は冪等なので、他の projection と
  一緒に再実行されても結果は同じ。retention job による一括の反映は従来どおり
  `TenantOperationFunction` が tenant table の stream から行う。
- NoEcho の値が Lambda の設定から読めなくなる。費用は既定の stack で secret 1 つ分
  （約 $0.40/月）増え、requestEmail module を有効にするとさらに 2 つ増える。
- worker の secret を rotation する deploy では `ApiRuntimeConfigurationRevision` を増やす。
  `cdk/README.md` に記載した。
