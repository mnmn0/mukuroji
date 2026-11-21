# 0044. Runtime control の切り替えを operator script が Workspace の監査ログに開始・完了・失敗の 3 種類で書く

- 状態: 提案
- 日付: 2026-11-21
- 関連: Issue #435, PR #615（切り替え command）, [ADR 0034](0034-read-only-maintenance-mode.md)（read-only mode）, [ADR 0039](0039-github-actions-oidc-deploy.md)（GitHub Actions の deploy role）, [ADR 0013](0013-data-migration-runner.md)

## 背景

`bun run runtime-control:enable|disable|read-only` は、誰が（STS caller ARN）いつ切り替えたかを AppConfig の hosted
version と deployment の description に残すだけだった（ADR 0034 の「結果」）。Workspace の owner や監査担当は
AWS console を見ないので、「いつメンテナンスで変更が止まっていたか」「誰が止めたか」を監査ログ
（`/api/audit/events`、export）から確かめられない。CloudTrail の management event は 90 日で消え、Workspace の
監査 retention・legal hold・export の対象にもならない。

一つの stack は一つの Workspace（stack parameter `WorkspaceDirectoryId`）を持つ。ADR 0013 は table 全体の migration を
Workspace の監査 event に載せないと決めたが、runtime control の切り替えはその Workspace の利用者全員の操作可否を
変えるので、Workspace の出来事として扱える。

## 決定

- `scripts/runtime-control.ts` が、切り替えのたびに AuditEvents table の Workspace partition へ次の event を書く。
  - `runtime-control.change-started`: hosted version を作る前。
  - `runtime-control.change-completed`: deployment が `COMPLETE` になり、`/api/ready` と `/api/maintenance` が新しい
    mode を示した後。
  - `runtime-control.change-failed`: rollback、待ち時間切れ、その他の失敗の後。理由は固定の短い code だけで、
    CLI の error 文は入れない。
- event は API と同じ `createMutationAuditContext` / `createAuditEvent`（`server/src/modules/audit/audit.ts`）で組み立て、
  `aws dynamodb put-item` に `attribute_not_exists` の条件を付けて一度だけ書く。actor は `kind=service`、`id` は
  STS caller ARN。GitHub Actions では起動した login と run を `displayName` と `metadata` に入れる。
  同じ実行の event は実行ごとの乱数 `switchId` で `correlationId` を共有し、event ID も `switchId` から決める
  （失敗後の再実行は同じ revision を使い得るため）。
- 保持期限は stack parameter `AuditRetentionDays` から計算し、tenant の retention・legal hold は既存の
  projection が後で反映する。通知・自動化の対象ではないので `outboxStatus=suppressed` で書く。
- 開始を記録できなければ、`enable` と `read-only` は AppConfig を変えずに止まる。`disable` は監査 table の障害が
  止める理由になり得るので、警告を出して止める操作を続ける。完了・失敗を記録できないときは警告だけ出す。
- GitHub Actions の deploy role（`cdk/deploy-access/github-deploy-access.template.json`）に、
  `${MukurojiStackName}-AuditEventsTable*` への `dynamodb:PutItem` を `dynamodb:LeadingKeys` = `WorkspaceDirectoryId`
  の条件付きで足す。手元から実行する operator の credential にも同じ権限が要る。

## 検討した選択肢

- 選択肢 A（採用）: operator script が Workspace の監査ログに直接書く。
  利点: 新しい resource が要らず、既存の監査 query・export・retention・legal hold にそのまま乗る。切り替える前に
  記録できる。欠点: 実行者の ARN は operator 自身の credential で書く値で、AppConfig の description と同じく自己申告の
  側面がある（STS が返した値をそのまま使うが、table に PutItem できる principal なら別の値も書ける）。
  deploy role が業務 table の一つに直接書き込めるようになる。
- 選択肢 B: API や worker が新しい revision を観測したときに記録する。
  利点: operator に table 権限が要らない。欠点: runtime は AppConfig Data しか読まず「誰が」を知らない。
  多数の Lambda が同時に観測するので重複を抑える仕組みも要る。
- 選択肢 C: 記録用の Lambda を作り、ADR 0031 と同じ presigned STS proof で実行者を確かめる。
  利点: 実行者が STS に認証された値になり、operator に table 権限が要らない。欠点: Lambda・role・proof の検証が増え、
  緊急停止の経路に Lambda の呼び出しが入る。
- 選択肢 D: CloudTrail の trail で AppConfig の操作を残す。
  利点: AWS 側の記録。欠点: Workspace の監査ログから見えず、trail と bucket の費用が増える。

選択肢 A の自己申告の欠点は、deploy role がすでに CDK の bootstrap role 経由で stack 全体（Lambda の code を含む）を
変えられ、監査 table への PutItem より強い権限を持つことから、追加の危険は小さいと判断した。

## 結果

- Workspace の owner と監査担当が、`/api/audit/events` と export で切り替えの開始・完了・失敗と実行者を確かめられる。
- deploy role は audit table の deployment Workspace partition に任意の event を書ける。IAM では条件付き書き込みを
  強制できないので、key を知っていれば既存 event の上書きもできる（削除・読み取りの権限はない。上書きは stream と
  PITR に残る）。実行者を強く証明する、または改ざんを防ぐ必要が出たら選択肢 C に移る。
- actor の ID は STS caller ARN なので、AWS account ID と IAM の user / role 名が Workspace の監査ログを読める人に見える。
- 2026-11-21 より前の template で deploy access stack を作った環境は、template を更新するまで切り替えが
  `enable` / `read-only` で止まる（`disable` は警告を出して続く）。
- ADR 0034 の「アプリの監査 log への自動保存は未実装のまま」はこの ADR で実装した。
- 更新した文書: `docs/event-audit.md`、`docs/operational-readiness.md`、`cdk/README.md`、`docs/guide/admin.md`。
