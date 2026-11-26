# Work Item workflow・custom field・relation

## 目的

この文書は、Workspace / Team ごとに設定できる workflow、custom field、Work Item relation の保存契約と運用手順を定義する。canonical Work Item の `schemaVersion=2` とは独立して、設定拡張には `workflowSchemaVersion=1` と `WorkItemConfigurationTable` を使う。

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
Child restore guard            = CHILD_RESTORE#<encoded-parentWorkItemId>
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
| `jobRoles` | no | Contributor を計画するジョブロールの配列。最大 100 件。各要素は stable `id`、表示名 `name`、任意の `archived` を持つ。 |
| `progressMode` | no | Work Item の進捗率の求め方。`status-category`（省略時）、`remaining-effort`、`manual`。詳細は [Work Items](work-items.md#estimate-remaining-effort-and-progress)。 |
| `parentCompletionPolicy` | no | 未完了の子がある親を完了にするときの扱い。`warn`（省略時）または `reject`。詳細は [親の完了ポリシー](#親の完了ポリシー)。 |
| `completionGate` | no | Work Item を完了にする前に満たす条件（完了 Gate）。省略時は条件なし。詳細は [完了 Gate](#完了-gate)。 |
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

Configuration mutation は `expectedRevision` を必須にする。新規 row の作成は `attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)`、更新は `revision = expectedRevision` を condition に含め、成功時だけ revision を増やす。Configuration の保存は `work-item-configuration.created` / `work-item-configuration.updated` の audit event を同じ transaction で記録し、この schema の CAS を迂回しない。

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

## Job role

Job role は Work Item の Contributor を、担当メンバーが決まる前から計画するための役割である。`id` は custom field と同じ文字種の stable ID で、表示名を保存 key にしない。

- 名称変更は `name` だけを変更する。保存済み Contributor は `id` で参照するため影響を受けない。
- 使わなくなったロールは削除せず `archived: true` にする。archive 済みロールは既存の Contributor に残せるが、新しい Contributor には設定できない。
- Contributor が参照しているロールを Configuration から削除する保存は `409 WorkItemConfigurationInUse` で拒否する。参照がなくなってから削除するか、archive する。
- それでも削除済みロールを参照する既存の Contributor は読み取りでは保持し、画面では「不明なジョブロール」と表示する。

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

この graph は意味上の relation を所有する。`blocks` / `blockedBy` も blocker の意味と検索・表示を表すだけで、Work Item の日付を暗黙に移動しない。Cross-Team / cross-Project の日程制約、lead / lag、constraint、cascade preview は PlanningTable の canonical Work Item schedule dependency が所有する。

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

Relation row の sort key は source Work Item ID から始まるため、`REL#<source>#` の prefix Query で 1 つの Work Item の近傍（親、子、依存、関連）だけを読める。`REL#<source>#<type>#` まで絞ると、親だけ・子だけを読める。Relation の一覧・作成・削除・付け替えはこの近傍読み取りだけを使い、Team の graph 全体を読まない。Team の graph 全体を読むのは Focus と Team 設定の互換性検証だけである。

各 canonical Work Item row は検索・backfill 用の派生 projection として `relationIds` を必須で持つ。値はその Work Item を source とする Relation Graph row から作る `type:targetWorkItemId` 形式で、辞書順、重複なし、最大100件とする。`child` row は projection に含めない。子は子側の `parent:<id>` で引けるため、親が持てる子の数を projection の上限で縛らない。Relation がない場合も空配列を保存する。Reader と backfill はこの形式を strict に検証し、不正または欠落した row を補完しない。

### 親子関係と上限

`parent` は 1 つの Work Item につき最大 1 件とする。親がある Work Item への `parent` 作成は `409 WorkItemParentAlreadyExists` で拒否する。親の付け替えは `PUT /api/teams/{teamId}/issues/{issueId}/parent`（body は `{ parentWorkItemId: string | null, expectedGraphRevision, hierarchyRank? }`）で行い、旧い親子 row の削除と新しい親子 row の作成を 1 つの transaction で確定する。`null` は親を外す。API は現在の親を読み、子・現在の親・新しい親の 3 つの endpoint を認可し、Work Item Type の親子制約と configuration revision を同じ transaction で検証する。現在の親が読んだ後に変わった場合は `409 WorkItemRelationGraphConflict` を返す。付け替えは宣言的な操作で、`hierarchyRank` を付けずに送り、子の親がすでに指定された親（`null` なら親なし）であれば graph revision に関係なく書き込まずに成功を返す。これで応答が失われた後の再送も成功として扱える。`hierarchyRank` を付けた場合は親が同じでも rank を書くので、`expectedGraphRevision` を確かめ、古ければ `409 WorkItemRelationGraphConflict` を返す（[兄弟の順序](#兄弟の順序hierarchyrank)）。ただし子に指定どおりの親と rank がすでに保存されていれば、graph revision に関係なく書き込まずに成功を返す。保存済みの rank を読めないときは `503 WorkItemRelationUnavailable` を返す。応答が失われた移動や並び替えの再送も成功として扱うためである。DynamoDB が item を拒否して transaction が取り消された場合（`ValidationError` / `ItemCollectionSizeLimitExceeded`）は再試行しても同じ結果になるので、読み直さずに `502 WorkItemRelationStoragePermanent` を返す。それ以外の理由で取り消された場合は graph・現在の親・endpoint を読み直し、どれも変わっていなければ競合ではなく再試行可能な `503 WorkItemRelationUnavailable` を返す。

残る上限は次のとおりで、`@mukuroji/contracts` の定数と一致させる。

| 上限 | 値 | 定数 |
| --- | --- | --- |
| 1 つの Work Item の `relationIds`（`child` を除く） | 100 | `WORK_ITEM_RELATION_ID_LIMIT` |
| 1 つの親が持てる子 | 上限なし | |
| 1 つの Team の relation link（reciprocal 2 row で 1 link） | 10,000 | `WORK_ITEM_TEAM_RELATION_LINK_LIMIT` |

Team の link 数は `RELATION_GRAPH` row の `edgeCount`（directed row 数）で数え、mutation ごとに同じ transaction で更新する。上限を超える作成・付け替えは `413 WorkItemRelationGraphLimitExceeded` で拒否する。`edgeCount` を持たない旧い graph row は、次の mutation で relation row を COUNT Query で数え直してから保存する。この上限は Focus など Team の graph を一括で読む処理の読み取り量を抑えるためのもので、relation mutation の読み取り量には影響しない。

### 兄弟の順序（`hierarchyRank`）

同じ親の子どうしの並び（最上位の Work Item どうしも含む）は、Work Item row の `hierarchyRank` で決める。値は `0-9a-z` の文字列で、最大 64 文字、末尾は `0` 以外とする（`isWorkItemHierarchyRank`）。辞書順に並べ、同じ値なら Work Item ID の順にする。2 つの rank の間には必ず別の rank を作れる（`createWorkItemHierarchyRankBetween`）。64 文字に収まらない場合だけ作れず、Web は「この位置にはこれ以上並べられません」と伝える。

`hierarchyRank` を持たない Work Item は、作成順の `sortOrder` と Work Item ID の hash から作る既定の rank（`createDefaultWorkItemHierarchyRank`）で並ぶ。hash を足すので、`sortOrder` が同じ兄弟でも rank は重ならず、その間へ移動できる。`sortOrder` は一覧の paging に使う GSI の range key なので、階層の並び替えには使わない。

`PUT .../parent` に `hierarchyRank` を付けると、親の付け替えと同じ transaction で子の rank を書く。親を変えずに rank だけを変える（上下の並び替え）と、子の row を revision と所属 Project を条件に更新し、同じ transaction で graph revision を 1 つ進める。親がある子では、認可に使った親の row（revision と所属 Project）と configuration の guard も同じ transaction の条件に入れる。認可の後に親が別の Project へ移されても、並び替えは確定しない。graph revision は読んだ値を条件にするので、並び替えも親の付け替えと同じく `expectedGraphRevision` が古ければ、またはその間に別の並び替えや親の変更があれば `409 WorkItemRelationGraphConflict` を返す。同じ移動を 2 人が同時に送っても、後の方は競合になる。親を変えて rank を付けない場合は保存済みの rank を消し、既定の順に戻す。relation API で `parent` を作ったとき、`parent` / `child` の関係を消したときも、子の rank を消す。取り消された並び替えは、子・親・graph revision・configuration guard のいずれかの条件が失敗していれば `409 WorkItemRelationGraphConflict` を返す。同時の書き込み（`TransactionConflict`）で取り消された場合は graph revision を読み直し、変わっていれば同じ `409`、変わっていなければ再試行可能な `503 WorkItemRelationUnavailable` を返す。DynamoDB が item を拒否した場合（`ValidationError` / `ItemCollectionSizeLimitExceeded`）は再試行しても同じ結果になるので、競合とも一時障害とも分けて `502 WorkItemRelationStoragePermanent` を返す。不正な rank は `400 InvalidWorkItemHierarchyRank` で拒否する。`relationIds` と同じく、rank の更新は Work Item の `revision` を進めない。

### 親の完了ポリシー

Configuration の `parentCompletionPolicy` は、完了でもキャンセルでもない子が残る親を完了にするときの扱いを決める。省略時は `warn` とする。

| 値 | 動き |
| --- | --- |
| `warn` | server は許可する。Web は status を完了にするどの画面（Team の Work Item、Project の task、My Tasks、Focus）でも、`GET /api/teams/{teamId}/issues/{issueId}/children/open-count` で読んだ未完了の子の数を示して確認してから更新する。数は読める・archive されていない直接の子だけを数える。数を読めなかったときも、数を示さずに確認してから更新する。 |
| `reject` | Work Item が completed category の status に移るとき、server が直接の子を読み、archive されていない未完了の子があれば `409 WorkItemOpenChildren` で拒否する。判定には呼び出し元が読めない子も含めるので、応答に件数は入れない。拒否の条件は Web・Public API・MCP・自動化のどの経路でも同じだが、応答の形は経路で異なる。Team の API は `409` と `code: "WorkItemOpenChildren"` を返し、Public API は共通の error 形式に写すので `409` と `code: "conflict"`、`retryable: false` を返す（message は同じ）。承認で完了する場合は、承認を決定して status を変えるときに確認する。承認の依頼は status を変えないので、子が残っていても依頼できる。 |

子は relation graph の `child` row から読み、各子の詳細を 16 件ずつ読む。数えるのは直接の子だけで、孫は数えない。読んだ graph revision と各子の revision を親の更新 transaction の条件に入れるので、確認の後に子が付いたり子が再開されたりすると更新は `409` で失敗する（子の revision の条件は、同じ更新で送る他の configuration 条件（configuration guard、Type 変更の relation と承認の条件など）と合わせて 70 件に収まるときだけ入れる。収まらないときは graph revision だけを条件にし、子の再開は検出しない）。ポリシーの変更は他の configuration と同じく監査に残る。

### 完了 Gate

Configuration の `completionGate` は、Work Item が completed category の status に移る前に満たす条件を Team ごとに決める。条件ごとに `off`（省略時）、`warn`、`required` を選ぶ。`completionGate` を持たない、またはすべて `off` の Team では従来どおり何も検証せず、承認も読まない。

| 条件（policy の key） | 満たす状態 |
| --- | --- |
| `acceptance-criteria`（`acceptanceCriteria`） | 受け入れ条件がすべて `satisfied`。受け入れ条件が無い Work Item は満たす。同じ更新で送る `acceptanceCriteria` / `acceptanceCriteriaMarks` を反映した後の状態で判定する。 |
| `no-pending-approvals`（`noPendingApprovals`） | Work Item の承認に判断待ち（pending）と変更要求（changes requested）が無い。 |
| `human-approval`（`humanApproval`） | Work Item の承認が 1 件以上承認済み。承認者の role の指定はまだ無い。 |

`required` の条件が満たされないとき、server は completed category への遷移を拒否する。判定は Web の更新、Public API と MCP の `complete_task`、自動化の移動 action と一括操作、承認の決定による完了のどの経路でも同じで、応答の形だけが経路で異なる。

- Team の API は `409` と `code: "WorkItemCompletionGateNotSatisfied"`、`unmetConditions`（条件、`requirement`、`reason`、`message` の配列）を返す（`WorkItemCompletionGateErrorResponse`）。
- Public API は共通の error 形式に写し、`409`、`code: "conflict"`、`retryable: false` と、満たされない条件ごとに `errors[]` の `code: "gate_not_satisfied"` を返す。`message` は条件名で始まる。`ApiProblem.code` の enum は広げない。
- 承認の決定で完了する場合は、決定中の承認を承認済みとして数えて判定する。満たされなければ決定ごと拒否し、Work Item の更新と同じ `409 WorkItemCompletionGateNotSatisfied` と `unmetConditions` を返す。

承認の件数を読めなかったとき、承認の条件は `reason: "unavailable"` として満たされない扱いにする（fail-closed）。`warn` の条件は判定しても server は拒否しない。受け入れ条件は Work Item の row にあり、更新の revision 条件で固定される。判定する更新の `expectedRevision` が判定した revision と違えば `409 WorkItemRevisionConflict` を返す。承認の条件が `required` で満たされたときは、判定した承認の件数（file proofing table の `APPROVAL_SUMMARY` row）を更新の transaction の条件に入れる。判定の後に承認が作られたり決定されたりすると、更新は `409` で失敗する。承認の決定で完了する場合は同じ row を決定の transaction が更新するので、別の条件ではなく、その更新に判定時の件数を条件として付ける。設定の変更は他の configuration と同じく監査に残る。

Web では、設定画面（ワークフローとフィールド）の「完了 Gate」で条件ごとに「使わない」「警告」「必須」を選ぶ。Work Item 詳細には、`warn` か `required` の条件がある Team でだけ、受け入れ条件の下に「完了 Gate」のチェックリストを出す。条件ごとに満たしているか、要求が警告か必須かを示し、保存済みの受け入れ条件と Work Item の承認の集計（`approvalSummary`。承認が無い Work Item では応答から省かれるので 0 件として数える）から contract の `describeWorkItemCompletionGate` で求める。表示は目安で、完了できるかは更新のときの server の判定で決まる。

Public API の `GET /api/v1/work-items/{workItemId}/completion-gate` と MCP の `get_task`（`completionGate`）は、同じ判定を server で行った結果を返す。Web の表示と違い、承認の件数は Gate の判定と同じく強い読み取りで読み、読めなければ `unavailable` にする（[Public API](public-api.md)）。

Work Item の manager（割り当てた Project の manager、Team の manager の直接の付与、system administrator。Project のない Work Item は Team の manager）は、Team API の更新に `completionGateOverride: { reason }`（前後の空白を除いて 1〜1,000 文字）を付けると、`required` の条件を満たさないまま完了にできる（[ADR 0100](adr/0100-completion-gate-manager-override.md)）。同じ更新で Project を移すときは移す前と後の両方の manager が要る。manager でない人と enterprise の service account は `403 ProjectAccessDenied`、理由が不正なら `400 InvalidWorkItemCompletionGateOverride`。override は Gate が拒否する更新でだけ効き、通した条件の ID と理由を監査 event `work-item.updated` の `metadata.completionGateOverride` と活動履歴の要約に残す。Public API・MCP・自動化・一括操作・承認の決定では override できない。override を通した更新は呼び出し元の役割を transaction の条件に入れるので、判定の後に manager の役割が外されると競合で失敗する。判定のときに満たしていた `required` の承認の条件は、override した更新でも承認の件数を commit まで固定する。Web ではタスク詳細の「完了 Gate」に、manager にだけ理由の入力欄が出る。受け入れ条件を編集中のときは、その編集内容で判定する。

CI、bot / 人の review、merge、未解決 blocker の条件、Update Feed と Factory board への override の表示は後続で扱う（#354）。

### 遷移を実行できる役割と状態ごとの必須項目

Workflow の transition は任意の `allowedActorRoles`（`project-manager`、`assignee`）を、status は任意の `requiredFields`（`due-date`、`acceptance-criteria`）と `requiredCustomFieldIds` を持てる。どれも省略または空のとき従来どおり何も検証しない（空の配列は保存時に取り除く）。`requiredCustomFieldIds` は configuration の custom field を指し、数式 field は指せない。どの Work Item にも担当者がいるので、担当者は必須項目に含めない（[ADR 0085](adr/0085-workflow-transition-actor-roles-and-status-requirements.md)）。

| 規則 | 満たす状態 |
| --- | --- |
| `allowedActorRoles` | 人が Web から操作し、次のどれかに当たる。`project-manager`: Work Item の Project（Project を移す更新では移す前と後の両方）の manager。Project のない Work Item では Team の manager（いずれかの Project の manager か `teams.manage`）。enterprise RBAC では、route を許可した権限ではなく role 割当の `projects.manage` / `teams.manage` で判定する。system admin は満たす。`assignee`: 変更前の担当者。同じ更新で自分を担当者にしても満たさない。 |
| `requiredFields` / `requiredCustomFieldIds` | 同じ更新で送る値を反映した後に、期限（schedule の期限か終了日）がある・受け入れ条件が 1 件以上ある・custom field に空でない値がある。Work Item の Type や Project で使えない custom field は、その Work Item には求めない（埋められないため）。 |

判定は status が変わるときだけ行う。同じ status のままの編集は止めない。遷移の分からない変更（初期状態以外での作成、別 workflow の Type への変更）は、その status に入る transition のうち最も制限の弱いものを使う。制限のない transition が 1 本でもあれば誰でも入れ、どの transition も入らない status は制限しない。作成には変更前の担当者がいないので `assignee` は満たさず、`project-manager` は作成先の Project（なければ Team）で判定する。初期状態での作成は status の変更ではないので、必須項目も判定しない。

自動化（Automation の action、Project template の展開）、developer credential（Public API、MCP、agent）、enterprise の service account は、credential の持ち主が manager でも `allowedActorRoles` を満たさない。人が判断する工程を表すための設定だからである。Web の一括操作とその取り消しは操作した人として判定し、承認の決定で status が変わるときは決定した人として判定する（承認の依頼は status を変えないので判定しない）。

拒否したときの応答は経路で形が異なる。

- Team の API は役割の不足を `403` と `code: "WorkflowTransitionActorDenied"`、必須項目の不足を `409` と `code: "WorkflowStatusRequirementsNotMet"` で返す。どちらも `unmetConditions`（`rule` が `transition-actor` / `required-field` / `required-custom-field` の配列、役割の不足を先に置く）を持つ（`WorkflowRuleErrorResponse`）。役割と必須項目の両方が足りないときは `403` に両方を入れる。
- Public API は共通の error 形式に写し、役割の不足は `403`、`code: "forbidden"`、必須項目の不足は `409`、`code: "conflict"` を返す（`retryable: false`）。満たされない規則ごとに `errors[]` へ `code: "transition_actor_denied"`（`pointer: "/workflowStatusId"`）または `code: "status_field_required"`（`pointer` は `/schedule`、`/acceptanceCriteria`、`/customFieldValues/<ID>`）を入れる。`ApiProblem.code` の enum は広げない。
- MCP は remote の文言を転送せず、`transition_actor_denied` なら人に頼むよう案内し、`status_field_required` なら形式を確かめた `pointer` だけを示す。

判定に使う役割は request の認可で読んだ Team の権限 context から求め、更新の transaction は既存の認可 snapshot と configuration guard で固定する。規則の変更は他の configuration と同じく監査に残る（workflow の policy hash に含まれる）。

### Reciprocal transaction と graph CAS

Team scope の `RELATION_GRAPH` row は `schemaVersion=1`、単調増加 `revision`、Team の directed relation row 数 `edgeCount` を持つ。Row が無い graph は revision `0` と解釈する。Relation list response は `graphRevision` を返し、作成/削除 input は `expectedGraphRevision` を必須にする。

Team scope の `CHILD_RESTORE#<encoded-parentWorkItemId>` row は `entryType=child-restore-guard`、`schemaVersion=1`、単調増加 `generation` を持つ。子の Work Item を復元する transaction は親の row を強整合で読み、検証した `generation` を条件に 1 進める（row が無ければ `attribute_not_exists` を条件に `generation=1` で作る。type・schema・generation が読んだ値と違う row は上書きせず復元を失敗させる）。親を archive する transaction は子を読む前に読んだ `generation`（row が無ければ `attribute_not_exists`）を ConditionCheck する。子の数によらない 1 項目で「確認の後に子が復元された」ことを検出するための row で、relation の変更には関わらない（[Work Items](work-items.md#archive復元と階層633)）。

Mutation 前に graph revision を読み、その後 endpoint の近傍と循環検証に必要な row を consistent read する。DynamoDB Query は複数 page を一つの snapshot として固定しないため、transaction で最初に読んだ graph revision を condition にし、途中で一件でも relation mutation があれば全 transaction を失敗させる。

作成 transaction は少なくとも次を含む。

1. Source Work Item の存在、認可時 revision、Project assignment を条件に、作成後の `relationIds` を保存する `Update`。
2. Target Work Item の存在、同じ Team scope、認可時 revision、Project assignment を条件に、reciprocal relation を含む作成後の `relationIds` を保存する `Update`。Reciprocal が `child` の場合は projection が変わらないため、同じ条件の `ConditionCheck` にする。
3. Graph metadata revision の condition 付き increment と `edgeCount` の更新。Revision 0 は `attribute_not_exists` を条件に row を作る。
4. Source relation projection の `attribute_not_exists` 付き Put。
5. Reciprocal relation projection の `attribute_not_exists` 付き Put。

削除も source / target の残存 relation から作った `relationIds` を両 Work Item row に保存し、両 projection の存在を条件に同じ transaction で削除して graph revision を更新する。Relation mutation は Work Item 本体の業務 state update ではないため、Work Item の `revision` と `updatedAt` は変更しない。どちらか一方だけ存在する状態を正常な削除として隠さず、repair が必要な corruption として fail-closed にする。Relation の追加・削除と親の付け替えは、両端の Work Item に対する audit event を同じ transaction で記録する（[`event-audit.md`](./event-audit.md) の「Work Item relation の event」）。

Relation mutation commit 後の Workspace search 更新は、source / target の canonical Work Item と現在の Relation Graph を強整合 read してから実行する。Approval 完了による Work Item 更新も同様に現在 row と relation を再取得する。再取得または search upsert が失敗しても、すでに確定した primary mutation の成功 response は失敗に変えない。

`TransactionCanceledException` は最新 graph / source / target / relation projection を consistent read して、not found、duplicate、stale `expectedGraphRevision`、corruption、未知 infrastructure error に分類する。すべてを generic conflict に変換しない。

### Cycle validation

Cycle は logical direction に対して検証し、物理 reciprocal row を独立 edge として数えない。

- `parent` / `child`: child から ancestor へ到達できる relation を追加しない。新しい親から `REL#<id>#parent#` を順に辿り、子に戻るかを確かめる。親は 1 つなので辿るのは祖先の 1 本の鎖だけである。
- `blocks` / `blockedBy`: target から source へ到達できる blocking relation を追加しない。Target から `REL#<id>#blocks#` を幅優先で辿り、各段の近傍読み取りは 16 件ずつ並列にする。
- `related` / `duplicate`: symmetric relation のため DAG cycle 判定対象にしない。Self / duplicate は引き続き拒否する。

Direct cycle と transitive cycle の両方を拒否する。1 回の検証で訪れる Work Item は Team の directed row 上限（20,000）までとし、超えた場合は検証を省略せず `413 WorkItemRelationTraversalLimitExceeded` で request を失敗させる。全 relation writer と repair tool は graph metadata revision を更新し、CAS を迂回しない。

既存の graph row からの移行（複数の親を持つ Work Item の整理、親の `relationIds` に残る `child:` の削除）は #365 の migration 契約で扱う。本番データがまだ無いため、この変更では移行処理を持たない。

## Backup / recovery

Configuration table と Work Items table は `Retain` + PITR を有効にする。高リスクな definition 変更の前には、対象 account / region、table 名、configuration revision、item count を記録し、必要に応じて on-demand backup を取得する。

誤削除や破損を検出した場合は先に write を停止し、PITR から別名 table へ復元する。復元 table の key schema、scope、configuration revision、relation graph revision、reciprocal pair を照合してから、review 済みの conditional repair または resource import で復旧する。確認前に元 table を削除したり、configuration / relation row を一括削除したりしない。
