# Workload, capacity, and resource allocation

Issue #33 の capacity planning は、Team の member profile、resource request、resource assignment を正本にし、#27 の planning と #32 の time tracking を read model として組み合わせます。

## Availability rules

`WorkloadMemberProfile` は IANA `timeZone`、曜日ごとの working minutes、holiday、time off、skills、role を保持します。`fromDate` / `toDate` は member の local calendar date です。

1. 曜日の schedule が disabled なら capacity は 0 です。
2. holiday はその日の capacity を 0 にします。
3. `approved` の time off は `minutesPerDay`（省略時は scheduled minutes）を差し引き、capacity が負にならないよう 0 にします。`planned`（承認待ち）は差し引かず、承認済みで残った空きを上限に cell の `pendingTimeOffMinutes` として返します。`rejected` と `canceled` は無視します。承認の導入前に保存された `planned`（`submittedAt` がない行）は、以前どおり capacity から引くよう読み取り時に `approved` として扱います（[ADR 0075](adr/0075-workload-time-off-approval-and-row-retention.md)）。
4. assignment の effort は、対象期間の available date に均等配分します。すべての日が unavailable の場合は指定された calendar date に配分し、overflow を検出できるようにします。
5. UTC の time entry は member の timezone の local midnight で分割します。DST の 23/25 時間日も calendar date として扱います。

## Demand and status

各 cell の値は次のように計算します。

- `allocatedMinutes`: active assignment の capacity reservation の合計。そのうち `tentative` の assignment の分を `tentativeAllocatedMinutes` に返します。
- `plannedEffortMinutes`: assignment が計画する Work Item effort の合計。
- `actualMinutes`: `submitted`、`approved`、`locked` の time entry の合計。draft と rejected は actual に含めません。snapshot は表示期間と、表示対象の Work Item assignment の期間を包含する bounded range を `TimeEntryTeamDateIndex` のキー条件で取得します。最大 7 日の time entry が期間境界を跨ぐため、開始時刻の下限だけはその分だけ前倒しします。
- `remainingEffortMinutes`: Work Item ごとに1つの source だけから決めます（0 未満にはしない）。Work Item に記録された残工数があればそれを使い、なければ正本見積（`schedule.plannedEffortMinutes`）から actual を差し引きます。見積もない Work Item だけは assignment の planned effort 合計から actual を差し引きます。見積と assignment の planned effort を二重に数えないよう、以前の `max(estimate, planned effort 合計)` は使いません。完了・キャンセル済みの Work Item は 0 です。この残工数は同じ Work Item を持つ assignment へ planned effort（0 の場合は allocation）で加重配分します。Work Item がない assignment は planned effort を残り工数の初期値にします。
- `varianceMinutes`: `capacityMinutes - allocatedMinutes`。
- `status`: capacity が 0 で demand がなければ `unavailable`、差が負なら `over`、0 なら `balanced`、正なら `under` です。

日次 cell を Monday-first の week、または calendar month に集約できます。member ごとに timezone が異なっても availability は member の local date で再現されます。

## Resource requests and assignments

`ResourceRequest` は project、role、skill、期間、requested effort、confidential flag を持ちます。assignment の allocation 合計に応じて `open`、`partially-filled`、`filled` を導出します。Team manager は（Project 付きの request は、その Project の manager でもある場合に） `PATCH /api/teams/:teamId/workload/requests/:requestId` で title、role、skill、期間、requested effort、confidential flag を変更し、`status: "canceled"` で取り消せます。request の `expectedRevision` と Team の `expectedTeamRevision` を検証し、stale write は `409` で拒否します。取消は、その request を埋める assignment がすべて `canceled` のときだけ受け付けます（残っていれば `409 ResourceRequestHasActiveAssignments`）。`cancelAssignments: true` を付けると残りの assignment も同じ書き込みで取り消します（confidential を見られない manager が見えない confidential の assignment を巻き込む場合は `409`）。巻き込む assignment ごとに、その Project の manager 権限と member の可視性を単独の assignment 変更と同じく確かめ、確認後に assignment が増えていれば `409 ResourceRequestAssignmentsChanged` を返します。取り消した request は変更できず、新しい assignment の追加や紐づく assignment の再有効化も `409 ResourceRequestCanceled` で拒否します。confidential な request は、confidential を見られない manager には `404` を返します。

`ResourceAssignment` は member、project / Work Item（必要に応じて Cycle / recurring-work の識別子も保持）、期間、allocation、planned effort、status を持ちます。drag/drop の reschedule / reassign は assignment の `expectedRevision` と Team の `expectedTeamRevision` を同時に検証し、stale write を `409` で拒否します。`POST /api/teams/:teamId/workload/what-if` は同じ計算を使いますが保存しません。

Team member 画面では、稼働プロファイル、time off、resource request、assignment の作成と what-if preview を実行できます。「休暇の申請と承認」では承認待ちを先頭に Team の time off を並べ、Team manager が承認・却下・承認待ちへの戻しを、本人が取り下げを行えます。heatmap は仮の assignment を破線で、承認待ちの休暇を cell の注記で示し、Team manager は assignment の詳細から確定・仮に戻す・取消を行えます。resource request の一覧では、status と request ID を確認し、request を編集・取消できます。保存済み assignment は元の期間を保ったまま heatmap のセル間で drag/drop して reschedule / reassign できます。assignment の詳細メニューにはキーボードで実行できる移動フォームもあります。

## Visibility

- Team viewer は自分とアクセス可能な project の member workload を見られます。
- project に紐づく request、assignment、time entry の集計は、viewer がアクセスできる project に限定します。project のない Team-wide レコードは Team の可視性に従います。
- member は自分の schedule と time off を変更できます。Team manager と Workspace owner / admin は他の member も変更できます。
- time off は member が planned として登録でき、approved / rejected への変更と他の member の time off の状態変更は Team manager（Workspace owner / admin を含む）に限定します。本人は自分の time off を取り下げ（`canceled`）・再申請（`planned`）できます。
- snapshot の member 行は表示開始日以降に終わる `canceled` 以外の time off を返し、`reason` は本人と confidential を見られる viewer にだけ返します。snapshot の `viewer` は viewer の member ID と Team manager かどうかを示します。
- confidential assignment / request は Team manager と assignment の本人だけが内容を見られます。非許可 viewer には行を返さず、snapshot の `redactedAssignmentCount` / `redactedRequestCount` だけを返します。
- guest は workload API の Team access を持たず、capacity planning の mutation は実行できません。

## HTTP surface

- `GET /api/teams/:teamId/workload?from=YYYY-MM-DD&to=YYYY-MM-DD&granularity=day|week|month`
- `PUT /api/teams/:teamId/workload/profiles/:memberId`
- `PUT /api/teams/:teamId/workload/profiles/:memberId/time-off/:timeOffId`
- `PATCH /api/teams/:teamId/workload/profiles/:memberId/time-off/:timeOffId`（`status`、time off の `expectedRevision`、`expectedTeamRevision`）
- `POST /api/teams/:teamId/workload/requests`
- `PATCH /api/teams/:teamId/workload/requests/:requestId`
- `POST /api/teams/:teamId/workload/assignments`
- `PATCH /api/teams/:teamId/workload/assignments/:assignmentId`
- `POST /api/teams/:teamId/workload/what-if`

Capacity planning state は Workspace / Team ごとに DynamoDB の一つの record として保存し、Team revision を CAS 条件にします。profile と assignment 自体にも revision を持たせ、同時編集で一部だけが反映される状態を防ぎます。record は DynamoDB item の 400 KB 制限を超えないよう保存前に byte budget を検証し、超過時は `413 CapacityPlanningLimitExceeded` を返します。保存のたびに、終了日から 30 日を過ぎた `canceled` / `rejected` の row と、状態にかかわらず終了日から 400 日を過ぎた row を消します（残る assignment が参照する request は残します）。

## Audit and notifications

profile 以外の変更（time off、request、assignment）は Team の record と同じ TransactWrite で shared audit event を書きます。entity type は `team-workload`（entity ID は Team ID）、event type は `workload.time-off.{requested,created,updated,approved,rejected,reopened,canceled}`、`workload.request.{created,updated,canceled}`、`workload.assignment.{created,updated,reassigned,confirmed,unconfirmed,canceled}` です。time off の `reason` と confidential な request の title は差分で伏せます。別の人が time off を変えると本人に、assignment を変えると変更前後の member に、audit projection が通知を作ります（操作した本人には送りません）。
