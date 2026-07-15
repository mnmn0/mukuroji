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

CDK は table を `PAY_PER_REQUEST`、PITR enabled、`Retain` で作成する。API Lambda だけが `WORK_ITEM_CONFIGURATION_TABLE_NAME` から table 名を受け取り、read/write と `TransactWriteItems` を行う。Realtime / projection Lambda はこの table を直接変更しない。

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
| `updatedAt` | no | 永続化済み configuration の最終更新を表す UTC ISO 8601 timestamp。built-in default では省略する。 |

未知の `schemaVersion`、不正 revision、scope key と payload の不一致を黙って読み飛ばさない。API は stable error を返し、管理 mutation と Work Item mutation を停止する。

### Workspace default と Team override

Configuration は次の優先順位で解決する。

1. 対象 Team の `CONFIG` row。
2. 対象 Workspace の `CONFIG` row。
3. Application に含まれる built-in default。

Team row は workflow と custom fields を含む一つの versioned snapshot であり、Workspace row との field-by-field merge はしない。部分 merge は、管理者が確認した revision と実際に検証された definition の組合せを曖昧にするためである。API response は `inheritedFrom=workspace|default` を返し、管理画面が継承状態を識別できるようにする。

CDK custom resource は Workspace / Team default row を強制 seed しない。未登録 scope は built-in default を使う。built-in default は標準 status ID を定義する通常仕様である。

| Status ID | Category |
| --- | --- |
| `todo` | `unstarted` |
| `in-progress` | `started` |
| `review` | `started` |
| `done` | `completed` |

### Configuration optimistic concurrency

Configuration mutation は `expectedRevision` を必須にする。新規 row の作成は `attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)`、更新は `revision = expectedRevision` を condition に含め、成功時だけ revision を増やす。監査 event の共通 transaction 化は audit 基盤を拡張する後続変更で扱い、この schema の CAS を迂回しない。

管理 mutation は scope ごとの期限付き `CONFIG_WRITE_LOCK` を先に条件付き取得し、Work Items base table を Team partition ごとに強整合 read して既存 Work Item との参照整合性を検証する。Work Item value/status mutation は、lock が存在しないか期限切れであることと、validation に使った configuration revision を同じ transaction の `ConditionCheck` で固定する。Configuration row の CAS Put と有効な lock の Delete は同じ transaction で確定し、lock 期限後や別 writer に引き継がれた validation result は保存しない。Validation 後に管理者が definition を変更した場合は Work Item を保存せず、最新 configuration と Work Item を再取得する。Team が Workspace default を継承している場合は、Team row と Team lock が transaction 中も存在しないこと、Workspace row revision、Workspace lock の4条件を guard する。

Required field の追加、type / option / currency / duration unit の変更、status の削除は既存 Work Item を不適合にする可能性がある。管理 API は次のいずれかを完了するまで変更を拒否する。

- 全対象 Work Item を新しい definition に適合させてから変更する。
- 旧 definition/status を archive 状態で残し、既存値の読み取りを維持する。
- Maintenance window で data correction と definition 切替を同じ reviewed procedure として実行する。

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

Work Item の `workflowStatusId` が workflow 上の正本で、`statusCategory` は list/filter/report 用に同じ mutation で保存する projection である。`workflowSchemaVersion` は検証に使用した configuration schema version を表す。作成時は指定 status が無ければ `initialStatusId` を適用する。更新時は現在 status から遷移先への明示 transition が無ければ保存しない。

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
| `duration` | Non-negative finite JSON number | Definition の `durationUnit=minutes\|hours\|days` を必須にし、`min` / `max` を同じ単位で適用する。 |
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

一つの logical relation は source projection と target reciprocal projection の2 rowで表す。この Relation Graph row を relation の正本とする。Relation ID / duplicate 判定は inverse request でも同じ logical edge に正規化する。Self relation、同じ logical edge の重複、scope 外 target を 400/409 として拒否する。

各 canonical Work Item row は検索・backfill 用の派生 projection として `relationIds` を必須で持つ。値はその Work Item を source とする Relation Graph row から作る `type:targetWorkItemId` 形式で、辞書順、重複なし、最大100件とする。Relation がない場合も空配列を保存する。Reader と backfill はこの形式を strict に検証し、不正または欠落した row を補完しない。

### Reciprocal transaction と graph CAS

Team scope の `RELATION_GRAPH` row は `schemaVersion=1` と単調増加 `revision` を持つ。Row が無い graph は revision `0` と解釈する。Relation list response は `graphRevision` を返し、作成/削除 input は `expectedGraphRevision` を必須にする。

Mutation 前に graph revision を読み、その後すべての relation page を consistent read して validation graph を作る。DynamoDB Query は複数 page を一つの snapshot として固定しないため、transaction で最初に読んだ graph revision を condition にし、途中で一件でも relation mutation があれば全 transaction を失敗させる。

作成 transaction は少なくとも次を含む。

1. Source Work Item の存在、認可時 revision、Project assignment を条件に、作成後の `relationIds` を保存する `Update`。
2. Target Work Item の存在、同じ Team scope、認可時 revision、Project assignment を条件に、reciprocal relation を含む作成後の `relationIds` を保存する `Update`。
3. Graph metadata revision の condition 付き increment。Revision 0 は `attribute_not_exists` を条件に row を作る。
4. Source relation projection の `attribute_not_exists` 付き Put。
5. Reciprocal relation projection の `attribute_not_exists` 付き Put。

削除も source / target の残存 relation から作った `relationIds` を両 Work Item row に保存し、両 projection の存在を条件に同じ transaction で削除して graph revision を更新する。Relation mutation は Work Item 本体の業務 state update ではないため、Work Item の `revision` と `updatedAt` は変更しない。どちらか一方だけ存在する状態を正常な削除として隠さず、repair が必要な corruption として fail-closed にする。Relation 監査の同一 transaction 化は audit 基盤を拡張する後続変更で扱う。

Relation mutation commit 後の Workspace search 更新は、source / target の canonical Work Item と現在の Relation Graph を強整合 read してから実行する。Approval 完了による Work Item 更新も同様に現在 row と relation を再取得する。再取得または search upsert が失敗しても、すでに確定した primary mutation の成功 response は失敗に変えない。

`TransactionCanceledException` は最新 graph / source / target / relation projection を consistent read して、not found、duplicate、stale `expectedGraphRevision`、corruption、未知 infrastructure error に分類する。すべてを generic conflict に変換しない。

### Cycle validation

Cycle は logical direction に対して検証し、物理 reciprocal row を独立 edge として数えない。

- `parent` / `child`: child から ancestor へ到達できる relation を追加しない。
- `blocks` / `blockedBy`: target から source へ到達できる blocking relation を追加しない。
- `related` / `duplicate`: symmetric relation のため DAG cycle 判定対象にしない。Self / duplicate は引き続き拒否する。

Direct cycle と transitive cycle の両方を拒否する。Graph scan には page size、最大 node/edge 数、最大 traversal depth を設定し、上限超過時は検証を省略せず request を失敗させる。全 relation writer と repair tool は graph metadata revision を更新し、CAS を迂回しない。

## Backup / recovery

Configuration table と Work Items table は `Retain` + PITR を有効にする。高リスクな definition 変更の前には、対象 account / region、table 名、configuration revision、item count を記録し、必要に応じて on-demand backup を取得する。

誤削除や破損を検出した場合は先に write を停止し、PITR から別名 table へ復元する。復元 table の key schema、scope、configuration revision、relation graph revision、reciprocal pair を照合してから、review 済みの conditional repair または resource import で復旧する。確認前に元 table を削除したり、configuration / relation row を一括削除したりしない。
