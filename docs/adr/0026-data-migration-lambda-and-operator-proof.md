# 0026. Data migration を operator が起動する Lambda で実行し、実行者を presigned STS proof で確かめる

- 状態: 提案
- 日付: 2026-11-20
- 関連: Issue #637、Issue #365、[ADR 0013](0013-data-migration-runner.md)、[docs/data-migration.md](../data-migration.md)

## 背景

ADR 0013 で migration の runner と checkpoint table の契約を決めたが、AWS 上で実行する手段がなかった。
CLI（`bun run data:migrate`）を AWS で使うには、operator が対象 table の `Scan` / `PutItem` を持つ必要があり、
手元の端末から 15 分を超える書き込みを流すことになる。GA 後に本番 data を持ったまま最初の schema 変更を出すには、
次を満たす実行経路が要る。

- 常時の固定費を増やさない（待機中は費用ゼロ）。
- operator に業務 table の書き込み権限を渡さない。
- 実行者・対象・結果を、改ざんしにくい形で残す。
- 途中で止まっても同じ command で再開できる（ADR 0013 の checkpoint をそのまま使う）。
- API Lambda role の inline policy 上限（#626）に影響しない。

Lambda は自分の role で動くので、Lambda の中で STS に問い合わせても function の role しか分からない。
Lambda の `Invoke` は CloudTrail の data event で、既定では記録されない。

## 決定

- `DataMigrationFunction`（Node.js 22、timeout 15 分、非同期 retry 0、trigger なし）を CDK に追加する。
  operator が `bun run data:migrate:aws` で同期起動したときだけ動く。runner と verifier は CLI と同じ code を使い、
  15 分の上限の 1 分前に新しい page を読むのをやめて `paused` を返す。
- 専用の role を作り、allowlist の table（`work-items`、`project-directory`）に `Scan` / `GetItem` / `PutItem`、
  `DataMigrationCheckpointTable` に `Query` / `PutItem` だけを与える。index、削除、table 操作の権限は与えない。
  payload に物理 table 名は載せず、定義の論理 `table` を CDK が渡す allowlist で物理名に変える。
  別の table を移行する migration は、同じ PR で allowlist に table を足す。
- `DataMigrationCheckpointTable` は ADR 0013 の key（`migrationId` / `partitionId`）で、`Retain`、PITR、
  deletion protection を付ける。
- operator には、この function の `lambda:InvokeFunction` だけを持つ未接続の `DataMigrationOperatorPolicy` を渡す。
- 書き込む起動（`--apply`）には、operator の credential で presign した STS `GetCallerIdentity` の URL を載せる。
  署名済み header `x-mukuroji-data-migration-request` に、function 名・command・migration ID・mode・上限・nonce
  の SHA-256 digest を入れる。Lambda は URL の宛先が自分の region の STS endpoint で、その header が署名に含まれる
  ことを確かめ、自分で計算した digest を付けて STS に送る。STS が返した ARN（function と同じ account のもの）を
  run record の実行者にする。確かめられなければ何も書かずに `OPERATOR_UNVERIFIED` で断る。
- 実行の記録は ADR 0013 の run record に加え、function の log group（1 年保持）に起動ごとの
  `data-migration.invocation` 行を残す。Workspace 単位の監査 event には載せない（ADR 0013 と同じ理由）。
- Floci での rehearsal（`bun run data:migrate:rehearsal`）は、Lambda と同じ adapter を in-process で通し、
  実行者の確認だけを固定値に置き換える。

## 検討した選択肢

- 選択肢 A（採用）: operator が起動する Lambda と presigned STS proof。
  利点: 待機中は費用ゼロ。operator は invoke 権限だけで、table 権限は function の role に閉じる。実行者は STS が
  認証した ARN で、payload の自己申告ではない。追加の AWS service が要らない（EKS の `aws-iam-authenticator` と同じ方式）。
  欠点: 実行者の確認を自前で実装する（宛先・parameter・header・応答の検証）。proof は有効期限（5 分、最大 15 分）内なら
  同じ payload で再利用できる。operator 側に `bun` と repository が要る。
- 選択肢 B: CloudTrail の trail で Lambda の data event を記録する。
  利点: 実装が要らず、AWS 側の記録になる。欠点: trail、S3 bucket、advanced event selector が増え、記録が run record と
  結び付かない。trail の有無に migration の安全性が依存する。
- 選択肢 C: payload に実行者を自己申告させる。
  利点: 簡単。欠点: invoke できる principal なら誰の名前でも書けるので、監査の記録にならない。
- 選択肢 D: Lambda を使わず、operator に table 権限の policy を渡して CLI を実行させる。
  利点: 新しい resource が要らない。STS の ARN がそのまま実行者になる。欠点: operator に業務 table の書き込み権限が
  渡る。端末の回線や sleep で実行が切れやすい（checkpoint で再開はできる）。
- 選択肢 E: Lambda function URL（`AWS_IAM` 認証）で起動し、request context の caller ARN を使う。
  利点: AWS が caller を認証する。欠点: 公開 endpoint が増え、SigV4 で署名した HTTP を送る client が要る。HTTP の
  接続を 15 分保つ必要がある。

## 結果

- GA 後の schema 変更は、dual-read の deploy → `data:migrate:aws` の dry run → `--apply` → `verify` の `pass` →
  dual-read の終了、の順に AWS 上で進められる。
- 新しい resource は table 1 つ、Lambda 1 つ、role 1 つ、managed policy 1 つ、log group 1 つ。on-demand と trigger なしの
  Lambda なので、使わない間の費用はほぼない。API Lambda role の policy は増えない。
- function の role は allowlist の table の任意の row を書ける。書き込むのは registry にある migration の
  transform だけで、registry の変更は PR の review を通る。
- 実行者の確認が STS の応答形式（JSON の `GetCallerIdentityResponse`）に依存する。形式が変わったら
  `OPERATOR_UNVERIFIED` で止まる（fail-closed）。
- 見直す条件: operator が増えて proof の再利用が問題になったら、nonce を checkpoint table に記録して一度だけ使えるようにする。
  migration が大きくなり 15 分ごとの再起動が負担になったら、Step Functions で再起動を回す。
- 更新した文書: `docs/data-migration.md`、`docs/architecture.md`、`cdk/README.md`。
