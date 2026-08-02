# Workload, capacity, and resource allocation

Issue #33 の capacity planning は、Team の member profile、resource request、resource assignment を正本にし、#27 の planning と #32 の time tracking を read model として組み合わせます。

## Availability rules

`WorkloadMemberProfile` は IANA `timeZone`、曜日ごとの working minutes、holiday、time off、skills、role を保持します。`fromDate` / `toDate` は member の local calendar date です。

1. 曜日の schedule が disabled なら capacity は 0 です。
2. holiday はその日の capacity を 0 にします。
3. canceled ではない time off は `minutesPerDay`（省略時は scheduled minutes）を差し引き、capacity が負にならないよう 0 にします。
4. assignment の effort は、対象期間の available date に均等配分します。すべての日が unavailable の場合は指定された calendar date に配分し、overflow を検出できるようにします。
5. UTC の time entry は member の timezone の local midnight で分割します。DST の 23/25 時間日も calendar date として扱います。

## Demand and status

各 cell の値は次のように計算します。

- `allocatedMinutes`: active assignment の capacity reservation の合計。
- `plannedEffortMinutes`: assignment が計画する Work Item effort の合計。
- `actualMinutes`: `submitted`、`approved`、`locked` の time entry の合計。draft と rejected は actual に含めません。
- `remainingEffortMinutes`: Work Item estimate と actual の差（0 未満にはしない）。Work Item がない assignment は planned effort を残り工数の初期値にします。
- `varianceMinutes`: `capacityMinutes - allocatedMinutes`。
- `status`: capacity が 0 で demand がなければ `unavailable`、差が負なら `over`、0 なら `balanced`、正なら `under` です。

日次 cell を Monday-first の week、または calendar month に集約できます。member ごとに timezone が異なっても availability は member の local date で再現されます。

## Resource requests and assignments

`ResourceRequest` は project、role、skill、期間、requested effort、confidential flag を持ちます。assignment の allocation 合計に応じて `open`、`partially-filled`、`filled` を導出します。

`ResourceAssignment` は member、project / Work Item（必要に応じて Cycle / recurring-work の識別子も保持）、期間、allocation、planned effort、status を持ちます。drag/drop の reschedule / reassign は assignment の `expectedRevision` と Team の `expectedTeamRevision` を同時に検証し、stale write を `409` で拒否します。`POST /api/teams/:teamId/workload/what-if` は同じ計算を使いますが保存しません。

Team member 画面では、稼働プロファイル、time off、resource request、assignment の作成と what-if preview を実行できます。保存済み assignment は heatmap のセル間で drag/drop して reschedule / reassign できます。

## Visibility

- Team viewer は自分とアクセス可能な project の member workload を見られます。
- member は自分の schedule と time off を変更できます。Team manager と Workspace owner / admin は他の member も変更できます。
- confidential assignment / request は Team manager と assignment の本人だけが内容を見られます。非許可 viewer には行を返さず、snapshot の `redactedAssignmentCount` / `redactedRequestCount` だけを返します。
- guest は workload API の Team access を持たず、capacity planning の mutation は実行できません。

## HTTP surface

- `GET /api/teams/:teamId/workload?from=YYYY-MM-DD&to=YYYY-MM-DD&granularity=day|week|month`
- `PUT /api/teams/:teamId/workload/profiles/:memberId`
- `PUT /api/teams/:teamId/workload/profiles/:memberId/time-off/:timeOffId`
- `POST /api/teams/:teamId/workload/requests`
- `POST /api/teams/:teamId/workload/assignments`
- `PATCH /api/teams/:teamId/workload/assignments/:assignmentId`
- `POST /api/teams/:teamId/workload/what-if`

Capacity planning state は Workspace / Team ごとに DynamoDB の一つの record として保存し、Team revision を CAS 条件にします。profile と assignment 自体にも revision を持たせ、同時編集で一部だけが反映される状態を防ぎます。record は DynamoDB item の 400 KB 制限を超えないよう保存前に byte budget を検証し、超過時は `413 CapacityPlanningLimitExceeded` を返します。
