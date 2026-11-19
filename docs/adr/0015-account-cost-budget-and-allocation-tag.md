# 0015. AWS アカウント全体の月次 Budget と cost allocation tag で費用を見える化する

- 状態: 提案
- 日付: 2026-11-20
- 関連: Issue #436、[cdk/README.md](../../cdk/README.md)「費用の目安と予算 alert」

## 背景

Mukuroji はなるべく安く AWS で動かす方針だが、stack には利用がなくてもかかる固定費（alarm、secret、KMS key）があり、
費用が増えても誰にも知らせる仕組みがなかった。何にいくらかかるかの目安も文書になかった。

制約は次のとおり。

- 見える化の仕組み自体に固定費を足さない。
- 運用者が deploy 以外の手作業をしなくても、超過の通知が誰かに届く。
- 既存の resource を作り直さない。

## 決定

- AWS Budgets を採用し、stack に月次のコスト予算（`AWS::Budgets::Budget`）を 1 つ作る。金額は
  `MonthlyCostBudgetUsd`（既定 $20）で、実績 80%・100% と予測 100% で email を送る。
- 送信先は `CostBudgetAlertEmail`。空なら必須 parameter の `InitialOwnerEmail` に送り、既定のままでも通知が届くようにする。
- 予算の対象は AWS アカウント全体にし、tag では絞らない。Mukuroji は専用アカウントに deploy する前提にする。
- tag を付けられる resource すべてに `mukuroji:application=mukuroji` を付ける（`cdk/lib/aspects/cost-allocation-tags.ts`）。
  stack-level tag と、tag の変更で作り直しになる AppConfig の deployment と deployment strategy は除く。

## 検討した選択肢

- 選択肢 A（採用）: アカウント全体の Budget と resource tag。Budget は通知だけなら無料で、tag の有効化を待たずに動く。
  欠点は、他のシステムと同じアカウントでは費用が合算されること。
- 選択肢 B: tag で絞った Budget。Mukuroji だけを数えられるが、tag は Billing console で有効にするまで Budgets に届かず、
  data transfer や税のように tag の付かない費用を数えない。有効化を忘れると予算が 0 のまま通知が来ない。
- 選択肢 C: CloudWatch の `EstimatedCharges` billing alarm。`us-east-1` にしか metric がなく、stack の region と分かれる。
  予測での通知もできない。
- 選択肢 D: SNS topic への通知。既存の alarm topic は外部所有で、Budgets が publish できる topic policy を stack から付けられない。

## 結果

- 既定構成で月額が設定値を超えると、初期 owner に email が届く。
- Budgets は請求データを 1 日に数回評価するため、通知は最大 1 日遅れる。急増の自動停止には使えない。
- tag で Cost Explorer の内訳を見るには、management account で cost allocation tag を有効にする手作業が残る。
- 任意 module の追加、毎分 schedule の見直し、Document の polling の見直しは Issue #436 の残りとして別の変更で行う。
- 更新した文書: `cdk/README.md`、`docs/operational-readiness.md`。
