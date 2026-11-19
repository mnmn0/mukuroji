# Data migration

保存済み row の schema version を上げる変更（例: 見積の統一、Project profile、calendar policy の参照化）が、
本番 data を消さずに移行するための契約です。設計判断は
[ADR 0013](adr/0013-data-migration-runner.md) にあります。

この文書が定めるのは「1 つの table の、1 つの entity の row を、schema version `N` から `N + 1` へ
移す」migration です。table の新設・key 設計の変更・別 table への copy は対象外で、それぞれ ADR を伴う
個別の変更として扱います。

## 構成

| 置き場所 | 役割 |
| --- | --- |
| `server/src/modules/data-migration/domain/` | migration 定義・checkpoint・counter・failure code の純粋な契約 |
| `server/src/modules/data-migration/application/` | bounded・再開可能な runner と、読み取り専用の verifier |
| `server/src/modules/data-migration/adapter-out/dynamodb/` | parallel scan segment で読む row store と、checkpoint table の store |
| `server/src/app/composition/data-migration.ts` | DynamoDB adapter と実行者（STS）の解決を組み立てる composition root |
| `server/scripts/migrations/registry.ts` | CLI から実行できる migration の一覧 |
| `server/scripts/migrations/run-data-migration.ts` | operator 向け CLI（`bun run data:migrate`） |

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
  `--max-pages` で上限を決め、使い切ると `paused`（exit 3）で終わります。同じ command をもう一度実行すると
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
- 内容: 実行者（STS `GetCallerIdentity` の ARN。local emulator では `local-emulator`）、物理 table 名、
  version、segment 数、状態（`started` → `completed` / `paused` / `failed`）、failure code、page 数、行数、開始・終了時刻

Migration は Workspace をまたいで table 全体を書き換えるため、Workspace 単位の監査 event
（[event-audit.md](event-audit.md)）ではなく、この run record と CloudTrail の IAM 記録を実行者の記録にします。
dry run と `verify` は書き込まないので記録しません。

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

```sh
bun run data:migrate list
bun run data:migrate run --migration <id> --table-name <table> --checkpoint-table-name <table>
bun run data:migrate run --migration <id> --table-name <table> --checkpoint-table-name <table> --apply
bun run data:migrate verify --migration <id> --table-name <table> --checkpoint-table-name <table>
```

- `run` は `--apply` を付けない限り dry run で、row も checkpoint も書きません。
- exit status: 0 完了 / `pass`、1 失敗、2 使い方の誤り・未登録の migration、3 `paused` / `incomplete`。
- AWS の table に対する `--apply` は、[server/AGENTS.md](../server/AGENTS.md) のとおりユーザーの明示確認を取ってから実行します。

### Checkpoint table

key は `migrationId`（partition key、S）と `partitionId`（sort key、S）です。checkpoint row は `schemaVersion: 2`
（物理 table 名を含む）を持ち、読み込み時に厳密に検証し、形の崩れた row は `CHECKPOINT_INVALID` で止まります。
run record は `RUN#` で始まる別の partition key に置きます。

local の emulator（Floci）では CLI が初回に table を作ります。Floci の parallel scan は `Limit` 付きで page を
またぐと segment の割り当てがずれ、行を読み飛ばすことがあります（2026-11 時点の `1.5.33` で確認。実 DynamoDB では
起きません）。local では `--segments 1` で実行してください。読み飛ばした場合も `verify` は `pending` を数えて
`fail` になります。AWS 上の table は CDK にまだ定義していません
（下記「未実装」）。

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

## 未実装（Issue #365 の残り）

- Floci で旧 schema の seed → migration → verify を 1 command で再現する rehearsal と、CI の smoke
- Lambda からの実行と、AWS 上の checkpoint table（CDK）
- Team / Workspace の partition を Query で読む row store（今は scan segment のみ）
- #335・#340・#337 の migration 定義
- `cdk/README.md` の個別手順の置き換えと、review Skill / `AGENTS.md` の push 前チェックへの組み込み
