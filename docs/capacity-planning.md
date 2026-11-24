# Workload, capacity, and resource allocation

Issue #33 の capacity planning は、Team の member profile、resource request、resource assignment を正本にし、#27 の planning と #32 の time tracking を read model として組み合わせます。

## Availability rules

`WorkloadMemberProfile` は IANA `timeZone`、曜日ごとの working minutes、holiday、time off、skills、role を保持します。`fromDate` / `toDate` は member の local calendar date です。

`calendarSource: "workspace"` の profile は Workspace カレンダー（#337）を継承します。計算の前に、`timeZone` を Workspace の time zone に、Workspace が稼働しない曜日を disabled に置き換え、Workspace の休日（会社の休日と、使う設定なら日本の祝日）を profile の holiday に足します。profile 側の曜日 schedule は個人の勤務時間と勤務しない曜日、holiday は個人の休みとして残ります。Workspace カレンダーは新しい Work Item の calendar policy と同じもの（`readWorkspaceWorkItemCalendarPolicy`）を使います。`calendarSource` が無い profile（継承の導入前に保存したもの）と `"custom"` は、profile 自身の time zone・schedule・holiday だけを使います。`PUT .../profiles/:memberId` で `calendarSource` を省くと、今の設定を保ちます（新しい profile は `"custom"`）。Web の稼働プロファイルは新しい profile を `"workspace"` で作ります。snapshot の member summary は編集用に保存値（継承前の time zone・schedule・holiday）と `calendarSource` を返し、cell の capacity は継承後の値です。

1. 曜日の schedule が disabled なら capacity は 0 です。
2. holiday はその日の capacity を 0 にします。
3. canceled ではない time off は `minutesPerDay`（省略時は scheduled minutes）を差し引き、capacity が負にならないよう 0 にします。
4. assignment の effort は、対象期間の available date に均等配分します。すべての日が unavailable の場合は指定された calendar date に配分し、overflow を検出できるようにします。
5. UTC の time entry は member の timezone の local midnight で分割します。DST の 23/25 時間日も calendar date として扱います。

## Demand and status

各 cell の値は次のように計算します。

- `allocatedMinutes`: active assignment の capacity reservation の合計。
- `plannedEffortMinutes`: assignment が計画する Work Item effort の合計。
- `actualMinutes`: `submitted`、`approved`、`locked` の time entry の合計。draft と rejected は actual に含めません。snapshot は表示期間と、表示対象の Work Item assignment の期間を包含する bounded range を `TimeEntryTeamDateIndex` のキー条件で取得します。最大 7 日の time entry が期間境界を跨ぐため、開始時刻の下限だけはその分だけ前倒しします。
- `remainingEffortMinutes`: Work Item ごとに1つの source だけから決めます（0 未満にはしない）。Work Item に記録された残工数があればそれを使い、なければ正本見積（`schedule.plannedEffortMinutes`）から actual を差し引きます。見積もない Work Item だけは assignment の planned effort 合計から actual を差し引きます。見積と assignment の planned effort を二重に数えないよう、以前の `max(estimate, planned effort 合計)` は使いません。完了・キャンセル済みの Work Item は 0 です。この残工数は同じ Work Item を持つ assignment へ planned effort（0 の場合は allocation）で加重配分します。Work Item がない assignment は planned effort を残り工数の初期値にします。
- `varianceMinutes`: `capacityMinutes - allocatedMinutes`。
- `status`: capacity が 0 で demand がなければ `unavailable`、差が負なら `over`、0 なら `balanced`、正なら `under` です。

日次 cell を Workspace の「週の開始曜日」から始まる week（未設定なら月曜始まり）、または calendar month に集約できます。member ごとに timezone が異なっても availability は member の local date で再現されます。

## Contributor の予定工数

Work Item の Contributor（#239）の予定工数は、capacity planning の state に保存せず、snapshot のたびに canonical Work Item から読みます。

- 数える分担は、member が決まっていて、`done` でなく、予定工数が 1 分以上ある分担です。Work Item が完了・キャンセル済み、archive 済み、日程なしの場合は数えません。ロールだけの分担は member の capacity に載せられないので数えません。
- 分担は Work Item の日程（範囲なら開始日〜終了日、期限だけなら期限日）に、予定工数を allocation と planned effort の両方として、assignment と同じ規則で配分します。
- その member が同じ Work Item の canceled でない resource assignment を持つ場合は（confidential を含め）、assignment が正本なので分担は数えません。
- Work Item の残工数は従来どおり Work Item ごとに1つの source から決め、resource assignment と Contributor の分担に planned effort で加重配分します。分担を足しても見積は二重に数えません。
- workload profile のない member、閲覧できない Project の Work Item の分担は数えません。
- snapshot の `contributorShares` に数えた分担を返します。`assignments` には入らず、heatmap で移動できません。
- Workspace 全体の合計（Team view の `workspaceAllocatedMinutes` と `/api/workload`）にも、全 Team の分担を同じ重複除外で数えます。合計は閲覧範囲によらず全件を数え、閲覧できない分は内訳で非表示の割当に入ります。そのため snapshot のたびに、対象の各 Team の見積を読みます。Team の snapshot で別 Team の見積を読めない（Work Item の読み取り上限を超えるなど）ときは、Workspace 合計を返さずに Team の値だけを返し、snapshot に `workspaceTotalsUnavailable: true` を付けます。画面にはその旨を表示します。それ以外の失敗は Team の snapshot も失敗にします。`/api/workload` は失敗として返し、分担を黙って落としません。

## Resource requests and assignments

`ResourceRequest` は project、role、skill、期間、requested effort、confidential flag を持ちます。assignment の allocation 合計に応じて `open`、`partially-filled`、`filled` を導出します。Team manager は（Project 付きの request は、その Project の manager でもある場合に） `PATCH /api/teams/:teamId/workload/requests/:requestId` で title、role、skill、期間、requested effort、confidential flag を変更し、`status: "canceled"` で取り消せます。request の `expectedRevision` と Team の `expectedTeamRevision` を検証し、stale write は `409` で拒否します。取消は、その request を埋める assignment がすべて `canceled` のときだけ受け付け（残っていれば `409 ResourceRequestHasActiveAssignments`）、取り消した request は変更できず、新しい assignment の追加や紐づく assignment の再有効化も `409 ResourceRequestCanceled` で拒否します。confidential な request は、confidential を見られない manager には `404` を返します。

`ResourceAssignment` は member、project / Work Item（必要に応じて Cycle / recurring-work の識別子も保持）、期間、allocation、planned effort、status を持ちます。drag/drop の reschedule / reassign は assignment の `expectedRevision` と Team の `expectedTeamRevision` を同時に検証し、stale write を `409` で拒否します。`POST /api/teams/:teamId/workload/what-if` は同じ計算を使いますが保存しません。

Team member 画面では、稼働プロファイル、time off、resource request、assignment の作成と what-if preview を実行できます。resource request の一覧では、status と request ID を確認し、request を編集・取消できます。保存済み assignment は元の期間を保ったまま heatmap のセル間で drag/drop して reschedule / reassign できます。assignment の詳細メニューにはキーボードで実行できる移動フォームもあります。

## Visibility

- Team viewer は自分とアクセス可能な project の member workload を見られます。
- project に紐づく request、assignment、time entry の集計は、viewer がアクセスできる project に限定します。project のない Team-wide レコードは Team の可視性に従います。
- member は自分の schedule と time off を変更できます。Team manager と Workspace owner / admin は他の member も変更できます。
- time off は member が planned として登録でき、approved への変更は Team manager に限定します。
- confidential assignment / request は Team manager と assignment の本人だけが内容を見られます。非許可 viewer には行を返さず、snapshot の `redactedAssignmentCount` / `redactedRequestCount` だけを返します。
- guest は workload API の Team access を持たず、capacity planning の mutation は実行できません。

## Workspace-wide totals

A member can have a profile and assignments in several Teams. Every Team view cell also carries the member's Workspace-wide totals, and `GET /api/workload` lists them for every member the caller may see across Teams ([ADR 0068](adr/0068-workspace-workload-across-teams.md)).

- `workspaceCapacityMinutes`: on each local date, the smallest capacity any of the member's Team profiles gives (after the Workspace calendar for inheriting profiles), so time off or a day off saved in one Team lowers the capacity everywhere.
- `workspaceAllocatedMinutes`: the allocation of every non-canceled assignment of the member in every Team, spread the way its own Team spreads it (over the dates that Team's profile makes available). It includes confidential assignments and assignments in Teams the viewer cannot see, as totals only.
- `workspaceStatus` uses the same rule as `status` on those totals, and the member's `workspaceOverloaded` is true when any cell is `over`. The Web colors a Team view cell as over and shows Workspace 全体では超過 when only the Workspace totals are over. The label does not name the cause: the Workspace totals also count confidential and other hidden allocation in the same Team.

`GET /api/workload?from&to&granularity` reads every Team record of the Workspace partition with a Query, sending the next Query from `LastEvaluatedKey` while one is returned (each Query returns at most 1 MB). It includes the Teams the caller may view (`teams.read` / Project viewer, as for the Team route; Workspace guests are denied) and, in each, the members that Team's workload visibility allows; Workspace owners / admins see every Team and member. Each cell returns the Workspace-wide capacity and total allocation, the allocation per viewable Team and per Project (`projects[].projectId` absent for Team-wide work), and `hiddenAllocatedMinutes`: allocation the caller may not see in detail, which is confidential assignments they are not allowed to see, Projects they cannot view, Teams they cannot view, and Teams whose member visibility leaves the member out. Archived Teams keep their record but count in no total, here or in the Team view's Workspace-wide fields. Actual time is not part of this view; each Team view still reports it. When a member's profiles use different time zones, each Team's dates are compared as local dates without conversion.

Changing an assignment still happens in its own Team. Assigning a member of another Team, and moving the storage from one record per Team to rows per member and period, are not implemented: one Team record stays within the 350 KB budget for the expected Workspace size (about 50 members), and the Workspace view reads all of them by paging through the partition.

## HTTP surface

- `GET /api/teams/:teamId/workload?from=YYYY-MM-DD&to=YYYY-MM-DD&granularity=day|week|month`
- `GET /api/workload?from=YYYY-MM-DD&to=YYYY-MM-DD&granularity=day|week|month`
- `PUT /api/teams/:teamId/workload/profiles/:memberId`
- `PUT /api/teams/:teamId/workload/profiles/:memberId/time-off/:timeOffId`
- `POST /api/teams/:teamId/workload/requests`
- `PATCH /api/teams/:teamId/workload/requests/:requestId`
- `POST /api/teams/:teamId/workload/assignments`
- `PATCH /api/teams/:teamId/workload/assignments/:assignmentId`
- `POST /api/teams/:teamId/workload/what-if`

Capacity planning state は Workspace / Team ごとに DynamoDB の一つの record として保存し、Team revision を CAS 条件にします。profile と assignment 自体にも revision を持たせ、同時編集で一部だけが反映される状態を防ぎます。record は DynamoDB item の 400 KB 制限を超えないよう保存前に byte budget を検証し、超過時は `413 CapacityPlanningLimitExceeded` を返します。
