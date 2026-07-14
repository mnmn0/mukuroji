# Work Item workflow・custom field・relation

## 目的

この文書は、Workspace / Team ごとに設定できる workflow、custom field、Work Item relation の保存契約と運用手順を定義する。既存 canonical Work Item の `schemaVersion=1` は変更せず、設定拡張には独立した `workflowSchemaVersion=1` と `WorkItemConfigurationTable` を使う。

設定が未登録でも既存 Workspace が停止しないこと、設定変更と Work Item 更新の競合を検出すること、relation の両側を同じ transaction で確定することを必須とする。

## DynamoDB table と key

`WorkItemConfigurationTable` は次の key schema を持つ。

| Key | Type | Description |
| --- | --- | --- |
| `scopeKey` | string partition key | Workspace または Workspace/Team の server-generated scope。 |
| `recordKey` | string sort key | Configuration、relation graph metadata、relation projection の種別と ID。 |

論理 key は次の形とする。component は server が canonical ID から構築し、request から物理 key を直接受け取らない。

```text
Workspace configuration scope = <encoded-directoryId>#work-item-configuration
Team configuration scope      = <encoded-directoryId>#team#<encoded-teamId>#work-item-configuration

CONFIG                         = CONFIG
Relation graph metadata        = RELATION_GRAPH
Relation projection            = REL#<encoded-sourceWorkItemId>#<relationType>#<encoded-targetWorkItemId>
```

ID に key delimiter を許可する場合は、すべての writer / reader で同じ percent-encoding を適用する。relation は Team scope にだけ保存し、Workspace をまたぐ key や Team ID を省略した key を作らない。

CDK は table を `PAY_PER_REQUEST`、PITR enabled、`Retain` で作成する。API Lambda だけが `WORK_ITEM_CONFIGURATION_TABLE_NAME` / `MUKUROJI_WORK_ITEM_CONFIGURATION_TABLE` から table 名を受け取り、read/write と `TransactWriteItems` を行う。Realtime / projection Lambda はこの table を直接変更しない。

## Configuration schema v1

`recordKey=CONFIG` の row は `@mukuroji/contracts` の `WorkItemConfiguration` と同じ論理 payload を持つ。

| Field | Required | Description |
| --- | --- | --- |
| `scopeKey` / `recordKey` | yes | DynamoDB key。 |
| `scopeType` | yes | `workspace` または `team`。物理 scope と一致すること。 |
| `scopeId` | yes | Workspace ID または Team ID。 |
| `schemaVersion` | yes | Configuration schema version。現在は `1`。 |
| `revision` | yes | 作成時 `1`、更新成功ごとに `1` 増加する正の整数。 |
| `workflow` | yes | 解決済み scope で使用する workflow definition。 |
| `customFields` | yes | Scope に適用する custom field definition の配列。 |
| `updatedAt` | yes | UTC ISO 8601 timestamp。 |

未知の `schemaVersion`、不正 revision、scope key と payload の不一致を黙って読み飛ばさない。API は stable error を返し、管理 mutation と Work Item mutation を停止する。

### Workspace default と Team override

Configuration は次の優先順位で解決する。

1. 対象 Team の `CONFIG` row。
2. 対象 Workspace の `CONFIG` row。
3. Application に含まれる built-in default。

Team row は workflow と custom fields を含む一つの versioned snapshot であり、Workspace row との field-by-field merge はしない。部分 merge は、管理者が確認した revision と実際に検証された definition の組合せを曖昧にするためである。API response は `inheritedFrom=workspace|default` を返し、管理画面が継承状態を識別できるようにする。

CDK custom resource や migration は Workspace / Team default row を強制 seed しない。未登録 scope は built-in default を使う。built-in default は既存 status ID を維持する。

| Status ID | Category |
| --- | --- |
| `todo` | `unstarted` |
| `in-progress` | `started` |
| `review` | `started` |
| `done` | `completed` |

### Configuration optimistic concurrency

Configuration mutation は `expectedRevision` を必須にする。新規 row の作成は `attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)`、更新は `revision = expectedRevision` を condition に含め、成功時だけ revision を増やす。監査 event の共通 transaction 化は audit 基盤を拡張する後続変更で扱い、この schema の CAS を迂回しない。

管理 mutation は scope ごとの期限付き `CONFIG_WRITE_LOCK` を先に条件付き取得し、Work Items base table を Team partition ごとに強整合 read して互換性を検証する。Work Item value/status mutation は、lock が存在しないか期限切れであることと、validation に使った configuration revision を同じ transaction の `ConditionCheck` で固定する。Configuration row の CAS Put と有効な lock の Delete は同じ transaction で確定し、lock 期限後や別 writer に引き継がれた validation result は保存しない。Validation 後に管理者が definition を変更した場合は Work Item を保存せず、最新 configuration と Work Item を再取得する。Team が Workspace default を継承している場合は、Team row と Team lock が transaction 中も存在しないこと、Workspace row revision、Workspace lock の4条件を guard する。

Required field の追加、type / option / currency / duration unit の変更、status の削除は既存 Work Item を不適合にする可能性がある。管理 API は次のいずれかを完了するまで変更を拒否する。

- 全対象 Work Item に適合する default/backfill plan を用意する。
- 旧 definition/status を archive 状態で残し、既存値の読み取りを維持する。
- Maintenance window で migration と definition 切替を同じ reviewed procedure として実行する。

## Workflow

Workflow は stable `id`、表示名、`initialStatusId`、status 配列、許可 transition 配列を持つ。Status は stable `id`、表示名、category、`sortOrder`、任意の color token を持つ。

Category は次の固定集合であり、list / board / report は表示名や status ID ではなく category を使って横断集計する。

- `backlog`
- `unstarted`
- `started`
- `completed`
- `canceled`

Definition 保存前に次を検証する。

- Workflow / status ID と表示名が空でなく、ID が scope 内で一意である。
- Status の `sortOrder` が有限数で、status ID を tie-breaker に安定整列できる。
- `initialStatusId` が status 配列に存在する。
- Transition の `fromStatusId` / `toStatusId` が両方とも同じ workflow に存在する。
- 同一 transition が重複せず、不明 status や自己 transition を暗黙に追加しない。
- In-use status を hard delete しない。

Work Item の `workflowStatusId` が workflow 上の正本で、`statusCategory` は list/filter/report 用に同じ mutation で保存する projection である。既存 `status` は schema v1 / legacy client 互換の field として維持するが、設定済み transition の許可判定には使わない。作成時は指定 status が無ければ `initialStatusId` を適用する。更新時は現在 status から遷移先への明示 transition が無ければ保存しない。

## Custom field

Definition は stable `id`、表示名、`type`、`sortOrder`、`required`、任意の `defaultValue` / `options` / `validation` / `projectIds` を持つ。Value は Work Item の `customFieldValues` object に definition ID を key として保存する。表示名や option 表示名を保存 key にしない。

`projectIds` が無い definition は scope の全 Work Item に適用する。指定されている場合は、Work Item の `assignedProjectId` が含まれるときだけ適用する。Project assignment と custom field value を同時変更するときは、変更後 snapshot 全体へ required/default/validation を適用する。

### Type と保存表現

| Type | Value representation | Validation |
| --- | --- | --- |
| `text` | JSON string | Control character を拒否し、`minLength` / `maxLength` / `pattern` を適用する。Pattern は definition 保存時に構文検証し、評価時間を制限できない危険な式を受け付けない。 |
| `number` | JSON number | `NaN` / infinity を拒否し、`min` / `max` を適用する。 |
| `boolean` | JSON boolean | `"true"`, `0`, `1` へ暗黙変換しない。 |
| `date` | `YYYY-MM-DD` string | 実在する Gregorian calendar 日付だけを受け付け、timezone を混在させない。 |
| `select` | option ID string | 現行 definition の option ID に完全一致すること。 |
| `multi-select` | 重複のない option ID string array | 各 ID が現行 option に存在し、`minLength` / `maxLength` を満たすこと。保存前に重複を拒否し、definition order で正規化する。 |
| `person` | Workspace member ID string | 同じ Workspace の active member であること。email 表示名を ID として新規保存しない。 |
| `currency` | Major unit の finite JSON number | Definition の uppercase ISO 4217 `currencyCode` を必須にし、currency minor-unit precision、`min` / `max` を適用する。 |
| `duration` | Non-negative finite JSON number | Definition の `durationUnit=minutes|hours|days` を必須にし、`min` / `max` を同じ単位で適用する。 |
| `formula` | API が算出する JSON number | Client input を拒否し、同じ mutation 内で参照 field から決定的に再計算して保存する。 |

`required=true` は空文字、空配列、未設定を拒否する。`false` と `0` は有効な値である。Default は definition 保存時にも同じ validator を通し、Work Item 作成時だけ補完する。更新のたびに削除済み value を default で復活させない。未知 field ID、scope 外 field、formula への直接入力を保存しない。

### Formula grammar

Formula は `eval` / `Function` を使わず、次の grammar を専用 parser で評価する。

```ebnf
formula        = expression ;
expression     = term , { ("+" | "-") , term } ;
term           = factor , { ("*" | "/") , factor } ;
factor         = [ "+" | "-" ] , ( number | field-reference | "(" , expression , ")" ) ;
field-reference = "{" , field-id , "}" ;
number         = digit , { digit } , [ "." , digit , { digit } ] ;
```

`{estimate}` のように stable field ID だけを参照する。参照先は `number` / `currency` / `duration` / `formula` で、同じ解決済み scope に存在しなければならない。String concatenation、function call、property access、assignment、comment、指数演算、global identifier は許可しない。Definition 保存時に構文と dependency graph を検証し、direct / transitive self-cycle を拒否する。Work Item mutation ごとに formula を依存順で再計算し、算出値を list / filter / report 用 projection として `customFieldValues` に保存する。Division by zero、非有限結果、missing input は validation error とし、黙って `0` にしない。

## Work Item relation

Relation は同じ Team が所有する Work Item 間だけで作成できる。API は source / target を Team partition の strongly consistent read で確認し、同名 ID が別 Team に存在しても参照しない。

Reciprocal type は次のとおりである。

| Source type | Reciprocal type |
| --- | --- |
| `parent` | `child` |
| `child` | `parent` |
| `blocks` | `blockedBy` |
| `blockedBy` | `blocks` |
| `related` | `related` |
| `duplicate` | `duplicate` |

一つの logical relation は source projection と target reciprocal projection の2 rowで表す。Relation ID / duplicate 判定は inverse request でも同じ logical edge に正規化する。Self relation、同じ logical edge の重複、scope 外 target を 400/409 として拒否する。

### Reciprocal transaction と graph CAS

Team scope の `RELATION_GRAPH` row は `schemaVersion=1` と単調増加 `revision` を持つ。Row が無い graph は revision `0` と解釈する。Relation list response は `graphRevision` を返し、作成/削除 input は `expectedGraphRevision` を必須にする。

Mutation 前に graph revision を読み、その後すべての relation page を consistent read して validation graph を作る。DynamoDB Query は複数 page を一つの snapshot として固定しないため、transaction で最初に読んだ graph revision を condition にし、途中で一件でも relation mutation があれば全 transaction を失敗させる。

作成 transaction は少なくとも次を含む。

1. Source Work Item の存在、認可時 revision、Project assignment の `ConditionCheck`。
2. Target Work Item の存在、同じ Team scope、認可時 revision、Project assignment の `ConditionCheck`。
3. Graph metadata revision の condition 付き increment。Revision 0 は `attribute_not_exists` を条件に row を作る。
4. Source relation projection の `attribute_not_exists` 付き Put。
5. Reciprocal relation projection の `attribute_not_exists` 付き Put。

削除は両 projection の存在を条件に同じ transaction で削除し、graph revision も同時に更新する。どちらか一方だけ存在する状態を正常な削除として隠さず、repair が必要な corruption として fail-closed にする。Relation 監査の同一 transaction 化は audit 基盤を拡張する後続変更で扱う。

`TransactionCanceledException` は最新 graph / source / target / relation projection を consistent read して、not found、duplicate、stale `expectedGraphRevision`、corruption、未知 infrastructure error に分類する。すべてを generic conflict に変換しない。

### Cycle validation

Cycle は logical direction に対して検証し、物理 reciprocal row を独立 edge として数えない。

- `parent` / `child`: child から ancestor へ到達できる relation を追加しない。
- `blocks` / `blockedBy`: target から source へ到達できる blocking relation を追加しない。
- `related` / `duplicate`: symmetric relation のため DAG cycle 判定対象にしない。Self / duplicate は引き続き拒否する。

Direct cycle と transitive cycle の両方を拒否する。Graph scan には page size、最大 node/edge 数、最大 traversal depth を設定し、上限超過時は検証を省略せず request を失敗させる。全 relation writer、migration、repair tool は graph metadata revision を更新し、CAS を迂回しない。

## Existing Work Item migration

Migration は `TeamIssuesTable` の key/schemaを変更せず、canonical Work Item row に次の fieldだけを additive backfill する。`WORK_ITEM_SCHEMA_VERSION` は `1` のまま維持する。

| Field | Backfill |
| --- | --- |
| `workflowSchemaVersion` | `1` |
| `workflowStatusId` | 既存 `status` と同じ ID |
| `statusCategory` | `todo -> unstarted`, `in-progress/review -> started`, `done -> completed` |
| `customFieldValues` | `{}` |

Script は未知 Work Item schema、不正 revision、未知 status、既存 metadata との矛盾、object でない `customFieldValues` を fail-closed にする。Update は key existence、`schemaVersion`、`revision`、既存 status、対象 metadata の `attribute_not_exists` を condition に含め、業務 fieldとrevisionを変更しない。Conditional race 後は consistent read し、同じ完成状態だけを duplicate success として扱う。

### 実行手順

1. 対象 account / region / `WorkItemsTableName`、item count、PITR、on-demand backup を記録する。
2. 既存 application のまま短い write freeze を設定し、完了まで新規 Work Item mutation を止める。
3. Configuration table と両 environment variable を含む application/CDK revision を deploy する。
4. Dry-run で全 row の `wouldUpdate` / `unchanged` / `invalid` を確認する。
5. Apply は事前 full preflight に成功した場合だけ実行する。
6. Verify で `missing=0 invalid=0` を確認する。
7. Team / project / Workspace list、dynamic board、filter/report、detail update、relation create/delete を確認して write を再開する。

```sh
export WORK_ITEMS_TABLE_NAME=<WorkItemsTableName>
export AWS_REGION=<region>

bun run work-item-configuration:migrate -- --dry-run
bun run work-item-configuration:migrate
bun run work-item-configuration:migrate -- --verify
```

Local emulator では必要な場合だけ `DYNAMODB_ENDPOINT` と test credentials を設定する。`--page-size` は1 page の評価件数、`--limit` は `--dry-run` / `--verify` の rehearsal・diagnostic 専用であり、apply との併用は拒否される。Production の完了確認に `--limit` 付き verify を使わない。Script は configuration table に Workspace / Team default rowを作らず、runtime inheritanceを維持する。

## Rollback / recovery

Configuration table と Work Items table は `Retain` + PITR のため、code rollback 時に削除しない。

1. Write を停止する。
2. 現行 CloudFormation template の `WorkItemConfigurationTable`、environment、IAM を残したまま、直前に成功していた application artifact だけへ戻す。必要なら table resource を残す rollback template を用意する。
3. 旧 code が Work Item の additive metadata を無視して既存 `status` を読めることを確認する。
4. Migration 前後の item count と代表 row を照合する。
5. Rollback window 中の configuration / relation write を監査し、write freeze は維持する。

旧 code は `status` の変更時に `workflowStatusId` / `statusCategory` を同期しないため、旧 application artifact のまま Work Item write を再開しない。Read-only rollback 後は、現行 writer へ roll-forward して `--verify` を通してから write を再開する。旧 UI/API での write 継続が不可欠な場合は、`status` と workflow metadata を同一 conditional write で同期する互換 writer を backport し、roll-forward 前に監査・reconcile・全件 verify を完了する。矛盾 metadata を残したまま現行 code へ戻さない。

Configuration table 追加前の CDK template をそのまま deploy して table を stack から外さない。`Retain` は物理 data を残すが CloudFormation の管理関係までは残さないため、誤って detach した場合は original table 名を記録し、roll-forward 前に resource import で同じ table を再接続してから Lambda environment と IAM resource を照合する。空の新規 table へ切り替えて運用を再開しない。

補完済み metadata や configuration/relation row を一括削除しない。Migration 後の正規 write と区別できず、relation の片側だけを失う可能性がある。Data corruption は PITR から別名 table へ復元し、graph revision と reciprocal pair を照合した reviewed conditional repair で前進修正する。
