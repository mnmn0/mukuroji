# Data migration

保存済み row の schema version を上げる変更（例: 見積の統一、Project profile、calendar policy の参照化）が、
本番 data を消さずに移行するための契約です。設計判断は
[ADR 0011](adr/0011-data-migration-runner.md) にあります。

この文書が定めるのは「1 つの table の、1 つの entity の row を、schema version `N` から `N + 1` へ
移す」migration です。table の新設・key 設計の変更・別 table への copy は対象外で、それぞれ ADR を伴う
個別の変更として扱います。

## 構成

| 置き場所 | 役割 |
| --- | --- |
| `server/src/modules/data-migration/domain/` | migration 定義・checkpoint・counter・failure code の純粋な契約 |
| `server/src/modules/data-migration/application/` | bounded・再開可能な runner と、読み取り専用の verifier |
| `server/src/modules/data-migration/adapter-out/dynamodb/` | parallel scan segment で読む row store と、checkpoint table の store |
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
  止まります。期限が切れた lease は引き継ぎます。
- checkpoint は作成時の segment 数と version を持ちます。segment 数や version を変えて同じ `id` を
  実行すると `PARTITION_PLAN_MISMATCH` / `DEFINITION_MISMATCH` で止まります。

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

- 実行中に止める: process を止めるだけでよい。checkpoint は最後に書き終えた page を指す。
- `verify` が `pass` になる前に戻す: dual-read の code は旧 version も読めるため、application の rollback は
  不要。migration の再開か、原因を直した新しい migration（新しい `id`）で進める。
- 旧 version しか読めない code へ戻す必要がある場合は、移行済み row を戻す逆向きの migration を別の
  `id` で用意する。PITR restore は最後の手段で、[operational-readiness.md](operational-readiness.md) の
  rollback 手順に従う。

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

key は `migrationId`（partition key、S）と `partitionId`（sort key、S）です。row は `schemaVersion: 1` を持ち、
読み込み時に厳密に検証し、形の崩れた row は `CHECKPOINT_INVALID` で止まります。

local の emulator（Floci）では CLI が初回に table を作ります。AWS 上の table は CDK にまだ定義していません
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
- 実行者と対象を audit event に記録すること
- #335・#340・#337 の migration 定義
- `cdk/README.md` の個別手順の置き換えと、review Skill / `AGENTS.md` の push 前チェックへの組み込み
