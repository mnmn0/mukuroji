# Data migration

保存済み row の schema version を上げる変更（例: 見積の統一、Project profile、calendar policy の参照化）が、
本番 data を消さずに移行するための契約です。設計判断は
[ADR 0013](adr/0013-data-migration-runner.md)（runner と checkpoint table）と
[ADR 0031](adr/0031-data-migration-lambda-and-operator-proof.md)（AWS 上の実行と実行者の検証）にあります。

この文書が定めるのは「1 つの table の、1 つの entity の row を、schema version `N` から `N + 1` へ
移す」migration と、同じ table に「元の row から決まる row（index row など）を作る」`derive` migration
（[ADR 0038](adr/0038-focus-member-work-item-index.md)）です。table の新設・key 設計の変更・別 table への copy は
対象外で、それぞれ ADR を伴う個別の変更として扱います。

## 構成

| 置き場所 | 役割 |
| --- | --- |
| `server/src/modules/data-migration/domain/` | migration 定義・checkpoint・counter・failure code の純粋な契約 |
| `server/src/modules/data-migration/application/` | bounded・再開可能な runner と、読み取り専用の verifier |
| `server/src/modules/data-migration/adapter-in/lambda/` | Lambda の起動 payload の検証と、run / verify の呼び出し |
| `server/src/modules/data-migration/adapter-out/dynamodb/` | parallel scan segment で読む row store と、checkpoint table の store |
| `server/src/modules/data-migration/adapter-out/sts/` | operator の proof（presigned STS `GetCallerIdentity`）の検証 |
| `server/src/app/composition/data-migration.ts` | DynamoDB adapter・実行者の解決・Lambda と rehearsal の依存を組み立てる composition root |
| `server/src/app/composition/data-migration-registry.ts` | CLI と Lambda から実行できる migration の一覧 |
| `server/src/handlers/data-migration-handler.ts` | Lambda の entrypoint（`DataMigrationFunction`） |
| `server/scripts/migrations/run-data-migration.ts` | table を直接読み書きする CLI（`bun run data:migrate`。local の Floci 向け） |
| `server/scripts/migrations/invoke-data-migration-lambda.ts` | AWS 上の Lambda を起動する operator 向け command（`bun run data:migrate:aws`） |
| `server/scripts/migrations/rehearse-data-migration.ts` | Floci で seed → migration → verify を通す rehearsal（`bun run data:migrate:rehearsal`） |
| `cdk/lib/subsystems/data-migration.ts` | checkpoint table、Lambda、role、operator policy |

migration 定義そのものは、その table を所有する module に置き、registry には一覧として並べるだけにします。

## Migration 定義の契約

`DataMigrationDefinition` は次を宣言します。runner は実行前に検証し、満たさない定義は
`DEFINITION_INVALID` で止めます。

| 項目 | 契約 |
| --- | --- |
| `id` | `NNNN-kebab-case`。checkpoint の partition key になるため、採用後は変えない |
| `table` | 論理名（`work-items` など）。物理 table 名は CLI の引数で渡し、定義と evidence には残さない |
| `keyAttributes` | primary key の attribute 名（1〜2 個）。transform は値を変えてはならない |
| `versionAttribute` | entity の schema version を持つ attribute。key attribute であってはならない |
| `fromSchemaVersion` / `toSchemaVersion` | `to = from + 1`。複数段の移行は migration を分ける |
| `writerPolicy` | `pause-writers` または `revision-fenced`（下記） |
| `revisionAttribute` | `revision-fenced` のときだけ必須。writer が進める revision の attribute |
| `classify(row)` | 純粋関数。`pending`（旧 version）、`migrated`（新 version）、`unrelated`（同じ table の別 entity）、`unknown` のどれかを返す |
| `transform(row)` | 純粋・決定的な関数。`pending` の row から新 version の row 全体を返す |

runner は `transform` の結果を書き込む前に、次をすべて確かめます。どれかが崩れたら `TRANSFORM_INVALID` で止まります。

- key attribute の値が変わっていない
- `revision-fenced` では revision の値が変わっていない（migration は revision を進めない）
- `versionAttribute` が `toSchemaVersion` になっている
- 結果を `classify` すると `migrated` になる

`classify` が `unknown` を返した row、または例外を投げた row は skip せず、その page を 1 行も書かずに
`UNKNOWN_ROW` で止まります。strict reader と同じ fail-closed の扱いです。

## 実行の単位と再開

- table は parallel scan の segment（`segment-<i>-of-<n>`、`--segments`、既定 4、最大 64）に分け、
  segment が checkpoint の partition になります。
- 1 page は strongly consistent な Scan で最大 100 行（`--page-size`）。1 回の実行で読む page 数は
  `--max-pages` で上限を決め、使い切ると `paused`（exit 3）で終わります。Lambda では、15 分の上限から
  1 分と「1 page を書き込み budget で書き切るのに最悪かかる時間」（page の行数 × 3 回 ÷ 毎秒の書き込み数）を
  引いた時刻を過ぎると、新しい page を読まずに `paused` で終わります。page は途中で切らないためです。同じ command をもう一度実行すると
  checkpoint の続きから再開します。
- 書き込みは `--max-writes-per-second`（既定 25）の間隔を空けます。
- 1 page を書き終えるたびに checkpoint を compare-and-set で保存します。page の途中で失敗した場合、
  checkpoint は前の page のままで、再実行するとその page を読み直します。書き込み済みの row は
  `migrated` に分類されるので二重には書きません（`alreadyMigrated` として数えます）。
- segment ごとに lease（5 分）を取り、別の実行が有効な lease を持つ segment には `LEASE_HELD` で
  止まります。期限が切れた lease は引き継ぎます。page の処理中も、残りが半分を切ると書き込みの前に
  lease を compare-and-set で延長し、負けたら（別の実行に取られたら）その時点で書き込みをやめて
  `CHECKPOINT_CONFLICT` で止まります。
- checkpoint は作成時の物理 table、segment 数、version を持ちます。別の table（restore した copy など）、
  別の segment 数、別の version で同じ `id` を再開しようとすると、それぞれ `TARGET_MISMATCH`、
  `PARTITION_PLAN_MISMATCH`、`DEFINITION_MISMATCH` で止まります。別の table を移行するときは、別の
  checkpoint table を使います。
- page の途中で止まった場合も、その page で書き込んだ行数は実行の report と run record に含めます。
  checkpoint の累計には含めず、再開時に `alreadyMigrated` として数えます。

### Row の置き換え

row は conditional put で置き換えます。条件は「key が存在し、`versionAttribute = fromSchemaVersion`、
`revision-fenced` では revision が読んだ値のまま」です。条件が外れたときは row を読み直し、

- row が消えていれば `vanished` として数える
- `migrated` になっていれば `alreadyMigrated` として数える
- まだ `pending` なら読み直した row から transform し直す（最大 3 回、超えたら `WRITE_CONFLICT`）
- それ以外なら `UNKNOWN_ROW`

### 派生 row の作成（`kind: 'derive'`）

`derive` の定義は `transform` の代わりに `derive(row)` を持ちます。

- `classify` は元の row（source）を `pending`、それ以外（作った派生 row を含む）を `unrelated` にする。
  `migrated` は使わない。
- `derive(row)` は純粋・決定的に派生 row の一覧（最大 50 行）を返す。runner は各派生 row が key attribute を持ち、
  元の row とも互いとも key が重ならず、`versionAttribute` が `toSchemaVersion` で、`classify` が `unrelated` を
  返すことを確かめ、崩れたら `TRANSFORM_INVALID` で止まる。`fromSchemaVersion` は `0`（派生 row がまだない）にする。
- 書き込みは 1 つの TransactWriteItems で、元の row の ConditionCheck（key があり、`revision-fenced` では revision が
  読んだ値のまま）と派生 row の Put（同じ key の row は上書き）をまとめる。元の row を書き換えないので、元の row の
  version は変わらない。条件が外れたときは元の row を読み直し、消えていれば `vanished`、まだ `pending` なら作り直す
  （最大 3 回）。
- 元の row は毎回 `pending` に見えるので、再開は checkpoint だけに頼る（完了した segment は読み直さない）。同じ
  migration を最初から流し直しても、派生 row を同じ内容で上書きするだけになる。
- verify は `pending` の row ごとに派生 row を強整合で読み、すべてが同じ内容で存在すれば `migratedRows`、欠けや
  違いがあれば `pendingRows` に数える。
- Lambda の role は allowlist の table に `dynamodb:ConditionCheckItem` も持つ。

登録済みの `derive` migration:

| id | table | 内容 |
| --- | --- | --- |
| `0001-work-item-member-index` | `work-items` | Work Item の責任者と Contributor ごとに Focus の index row を作る（ADR 0038）。Work Item の作成・更新・削除は同じ row を transaction で保つので、writer は止めない（`revision-fenced`） |

## Writer と dual-read

| `writerPolicy` | 条件 |
| --- | --- |
| `pause-writers` | migration の間、対象 entity を書く API・worker・schedule を止める。読み取り API は止めない |
| `revision-fenced` | writer は動かしたままでよい。すべての writer が row の revision を CAS で進めていること |

どちらの場合も、migration を始める前に次の順で deploy します。

1. **dual-read の deploy**: 読み取り側が `fromSchemaVersion` と `toSchemaVersion` の両方を読める code を
   出す。`revision-fenced` では writer は `toSchemaVersion` の row を書く。この時点から旧 row があっても
   読み取り API は fail-closed で止まらない。
2. **migration の実行**: dry run → `--apply` → `verify` が `pass` になるまで。
3. **dual-read の終了**: `verify` の `pass` を evidence に残した後、旧 version を読む code を消す deploy を出す。
   dual-read の期間はこの deploy までで、`verify` が `pass` になる前に旧 version の reader を消してはいけない。

strict reader が未知の version を fail-closed にする方針（[work-items.md](work-items.md) など）は変えません。
dual-read の期間だけ、reader が既知の 2 つの version を受け入れます。

## Verify と integrity check

`verify` は書き込みを一切せず、checkpoint と table 全体を読みます。

- すべての segment の checkpoint が `completed`
- `pending` の row が 0
- `unknown` の row が 0

の 3 つを満たすと `pass`（exit 0）です。page 上限で読み切れなかった場合は `incomplete`（exit 3）で、
成功とはみなしません。migration 後は、対象 table の既存の integrity check（[data-integrity.md](data-integrity.md)、
`bun run work-items:integrity`、`bun run cross-domain:integrity`）も通します。
[operational-readiness.md](operational-readiness.md) の deploy 後確認「Migration marker/checkpoint/integrity
check が成功」は、この `verify` の `pass` と integrity check の成功を指します。

## Rollback

この runner は version を 1 つ上げる向きにしか動かず、row を旧 version に戻すことはできません。
そのため rollback は「旧 version も読める code を保つ」ことで行います。

- 実行中に止める: process を止めるだけでよい。checkpoint は最後に書き終えた page を指す。
- 移行を始めた後に戻す: dual-read の code は旧・新どちらの row も読めるため、application はこの code
  （またはこれ以降の code）のまま止めておけば読み取りは壊れない。原因を直して再開するか、直した
  transform を新しい `id`（同じ version の組）で用意して残りを進める。
- 1 行でも移行した後に、旧 version しか読めない code へ戻してはいけない。旧 version の reader は新しい
  version の row を fail-closed で拒否する。どうしても旧 code に戻す必要がある場合の手段は PITR restore だけで、
  [operational-readiness.md](operational-readiness.md) の rollback 手順に従い、restore 時点以降の書き込みを
  失うことを判断したうえで行う。

## 実行者の記録（run record）

`--apply` の実行は、最初の row を書く前に run record を checkpoint table に保存し、実行の終わりに同じ
record を結果で更新します。保存できなければ row を 1 行も書かずに `RUN_LOG_FAILED` で止まります。

- key: `migrationId = RUN#<migration id>`、`partitionId = <開始時刻>#<run ID>`（checkpoint の partition とは分ける）
- 内容: 実行者（CLI では STS `GetCallerIdentity` の ARN、Lambda では operator の proof を STS で確かめた ARN。
  local emulator と rehearsal では `local-emulator`）、物理 table 名、
  version、segment 数、状態（`started` → `completed` / `paused` / `failed`）、failure code、page 数、行数、開始・終了時刻

Migration は Workspace をまたいで table 全体を書き換えるため、Workspace 単位の監査 event
（[event-audit.md](event-audit.md)）ではなく、この run record を実行者の記録にします。dry run と `verify` は
書き込まないので run record を作りません。

Lambda で実行した場合は、これに加えて function の log group（1 年保持）に、起動ごとに 1 行の
`data-migration.invocation` を残します。中身は Lambda の request ID、command、migration ID、論理 table 名、mode、
status、counter、`--apply` では確かめた実行者の ARN です。物理 table 名、key、row の内容、proof は入りません。
`list` と、断った起動（不正な payload の `INVALID_REQUEST`、`MIGRATION_NOT_FOUND`、`TABLE_NOT_CONFIGURED`）も
1 行ずつ残ります。proof を確かめられずに断った `--apply` は `OPERATOR_UNVERIFIED` として、理由の code
（`STS_REJECTED`、`PROOF_TARGET_INVALID`、`PROOF_EXPIRED`、`ACCOUNT_MISMATCH` など）付きで残ります。

### AWS 上の実行者の確認（operator proof）

Lambda は自分の role で table を読み書きするので、STS に自分を問い合わせても function の role しか分かりません。
そこで `--apply` の起動には、operator が自分の AWS credential で作った STS `GetCallerIdentity` の presigned URL
（有効期限 5 分、最大 15 分まで受け付ける）を `operatorProof` として載せます。

- operator 側（`bun run data:migrate:aws`）は、function 名・command・migration ID・`apply`・segment 数・
  page 数・書き込み budget・起動ごとの nonce から SHA-256 の digest を作り、`x-mukuroji-data-migration-request`
  header の値として署名に含めます。URL には digest を載せません。
- Lambda は URL が自分の region の `https://sts.<region>.amazonaws.com/` への `GetCallerIdentity` で、その header が
  署名に含まれることを確かめてから、自分で計算した digest を header に入れて送ります。payload の別の値や別の起動の
  proof では署名が合わず、STS が拒否します。redirect は追わず、5 秒で打ち切ります。
- STS は presigned `GetCallerIdentity` を `X-Amz-Expires` にかかわらず署名から 15 分受け付けるため、Lambda は
  STS へ送る前に `X-Amz-Date` と `X-Amz-Expires` から期限を自分で確かめます。期限を過ぎた proof は
  `PROOF_EXPIRED`、署名時刻が 1 分より先の proof は `PROOF_NOT_YET_VALID` で断ります。
- STS が返した `Arn` と `Account` を使い、`Account` が function の account と違えば断ります。ARN は payload から
  受け取りません。
- proof も digest も log や response に出しません。

同じ proof は有効期限内なら同じ payload でもう一度使えますが、その起動も同じ operator の同じ実行として記録され、
lease が同時実行を防ぎます。function を起動できる principal は `DataMigrationOperatorPolicy` を付けた operator に
限ります。

## Evidence

CLI は stdout に 1 行の JSON を出します。key、row の内容、物理 table 名、raw の AWS error は含みません。

- `run`: `migrationId`、論理 `table`、version、`mode`（`dry-run` / `apply`）、`runId`、`status`
  （`completed` / `paused` / `failed`）、`failureCode`、`pagesRead`、counter（`scanned`、`migrated`、
  `alreadyMigrated`、`unrelated`、`vanished`）と segment ごとの内訳、開始・終了時刻。dry run の `migrated` は
  「置き換える予定の行数」です。
- `verify`: `status`（`pass` / `fail` / `incomplete`）、segment 数と完了数、行数の内訳。

release evidence には、対象 commit、実行した command（物理 table 名を除く）、各実行の JSON、最後の
`verify` の JSON、integrity check の結果を残します。

## CLI

AWS 上の table には `bun run data:migrate:aws`（下記）を使います。`bun run data:migrate` は table を直接
読み書きするので、local の Floci と、table の権限を持つ principal で緊急に実行する場合に限ります。

```sh
bun run data:migrate list
bun run data:migrate run --migration <id> --table-name <table> --checkpoint-table-name <table>
bun run data:migrate run --migration <id> --table-name <table> --checkpoint-table-name <table> --apply
bun run data:migrate verify --migration <id> --table-name <table> --checkpoint-table-name <table>
```

- `run` は `--apply` を付けない限り dry run で、row も checkpoint も書きません。
- exit status: 0 完了 / `pass`、1 失敗、2 使い方の誤り・未登録の migration、3 `paused` / `incomplete`。
- AWS の table に対する `--apply` は、[server/AGENTS.md](../server/AGENTS.md) のとおりユーザーの明示確認を取ってから実行します。

### AWS 上の Lambda で実行する

```sh
bun run data:migrate:aws list --function-name <DataMigrationFunctionName>
bun run data:migrate:aws run --function-name <name> --migration <id>
bun run data:migrate:aws run --function-name <name> --migration <id> --apply
bun run data:migrate:aws verify --function-name <name> --migration <id>
```

- function 名は stack output `DataMigrationFunctionName` です（ARN ではなく名前を渡す）。region は `--region`、
  なければ `AWS_REGION` / `AWS_DEFAULT_REGION`。
- payload に物理 table 名は載りません。Lambda は定義の論理 `table` を、CDK が渡す allowlist
  （`DATA_MIGRATION_TARGET_TABLES`）で物理名に変えます。allowlist に無い table の migration は
  `TABLE_NOT_CONFIGURED` で断ります。
- `--segments`、`--page-size`、`--max-pages`、`--max-writes-per-second` と exit status は `data:migrate` と同じです。
  Lambda が返す JSON をそのまま 1 行で出します。断られた場合の `code` は `INVALID_REQUEST`、`MIGRATION_NOT_FOUND`、
  `TABLE_NOT_CONFIGURED`、`OPERATOR_UNVERIFIED` と、下記の failure code です。
- 1 回の起動は同期で待ち、retry しません。CDK の構成と IAM は [cdk/README.md](../cdk/README.md)「Data migration」にあります。

### Floci での rehearsal

```sh
MUKUROJI_LOCAL_AWS_RUNTIME=floci DYNAMODB_ENDPOINT=http://localhost:4566 bun run data:migrate:rehearsal
```

local の DynamoDB endpoint でだけ動きます。使い捨ての table に旧 schema の row（既定 60 行、`--rows` で 11〜9999。1 page の 10 行より多くないと中断を再現できない）と
移行済み・別 entity の row を入れ、Lambda と同じ adapter を通して次を順に確かめ、最後に table を消します
（`--keep` で残す）。

1. `list` に rehearsal 用の migration が出る
2. dry run が全行を数え、何も書かない
3. proof の無い `--apply` を断る
4. 1 page で止めた `--apply` が `paused` になる
5. 途中の `verify` が `fail` になる
6. 再実行した `--apply` が続きから `completed` になる
7. `verify` が `pass` になる
8. run record が 2 件（`paused` と `completed`）残る

STS は使えないので、実行者の確認だけは固定の `local-emulator` に置き換えます（実行者の確認は unit test で確かめます）。
Floci の scan の不具合を避けるため segment は 1 です。

CI では `.github/workflows/local-runtime.yml` の「Rehearse data migration」step が、Floci を起動した後に同じ command を実行します。

### Checkpoint table

key は `migrationId`（partition key、S）と `partitionId`（sort key、S）です。checkpoint row は `schemaVersion: 2`
（物理 table 名を含む）を持ち、読み込み時に厳密に検証し、形の崩れた row は `CHECKPOINT_INVALID` で止まります。
run record は `RUN#` で始まる別の partition key に置きます。

local の emulator（Floci）では CLI が初回に table を作ります。Floci の parallel scan は `Limit` 付きで page を
またぐと segment の割り当てがずれ、行を読み飛ばすことがあります（2026-11 時点の `1.5.33` で確認。実 DynamoDB では
起きません）。local では `--segments 1` で実行してください。読み飛ばした場合も `verify` は `pending` を数えて
`fail` になります。AWS 上では CDK の `DataMigrationCheckpointTable`（`Retain`、PITR、deletion protection）を
使います。

## Failure code

| code | 意味 |
| --- | --- |
| `DEFINITION_INVALID` | 定義・registry・実行の上限が契約に合わない |
| `DEFINITION_MISMATCH` | checkpoint が別の version で作られている |
| `PARTITION_PLAN_MISMATCH` | checkpoint が別の segment 数で作られている |
| `LEASE_HELD` | 別の実行が有効な lease を持つ |
| `CHECKPOINT_CONFLICT` | checkpoint の compare-and-set に負けた |
| `CHECKPOINT_INVALID` | checkpoint row または cursor の形が崩れている |
| `TARGET_MISMATCH` | checkpoint が別の物理 table のものである |
| `RUN_LOG_FAILED` | 実行者を特定できない、または run record を保存できない |
| `UNKNOWN_ROW` | 分類できない row がある |
| `TRANSFORM_INVALID` | transform の結果が契約に合わない |
| `WRITE_CONFLICT` | 同じ row の置き換えが 3 回続けて条件に負けた |
| `CURSOR_REPEATED` | page の cursor が進まない |
| `UPSTREAM_FAILURE` | DynamoDB などの呼び出しに失敗した。SDK error の class 名（`AccessDeniedException` など）が分かるときは `failureDetail`（CLI の error 出力では `detail`）に載せる。message は載せない |

## 新しい schema 変更の PR の確認項目

保存済み row の schema version を上げる PR は、同じ PR で次をそろえます。

- この文書の契約を満たす migration 定義と、registry への追加
- 旧 version の fixture から `pending` → `migrated` になる test、`unknown` を返す row の test
- dual-read の reader（`fromSchemaVersion` と `toSchemaVersion` の両方を読む）
- Floci 上の dry run・`--apply`・`verify` の結果

## 対象外にしたもの（Issue #365）

- **Team / Workspace の partition を Query で読む row store**: [ADR 0013](adr/0013-data-migration-runner.md) のとおり、
  必要な migration が出たときに足します。今の対象 table（`work-items`、`project-directory`）は parallel scan の
  segment で読み切れる規模で、Workspace をまたいで table 全体を移すので Query の単位が要りません。
- **#335・#340・#337 の migration 定義**: これらの schema 変更は初回 deploy（#636）より前に入り、旧 version の row を
  持つ環境がまだ無いため、migration は作りません。初回 deploy の後に保存済み row の version を上げる変更は、
  上の確認項目に従って migration を同じ PR に入れます。push 前チェックは [AGENTS.md](../AGENTS.md) と
  review Skill の data integrity の観点で確かめます。
- **実 AWS 上の operator proof（STS）の往復**: Floci には STS が無いので、初回 deploy 後の確認
  （[post-deploy-verification.md](post-deploy-verification.md)、#636）で確かめます。
