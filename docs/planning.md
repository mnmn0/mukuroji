# Planning domain

Issue #27 の Planning domain は、短期の Cycle と中長期の Portfolio / Roadmap / Initiative / Goal、Project phase / Milestone / Release を一つの Workspace graph として扱います。Canonical Work Item 自体に計画フィールドを重複保存せず、Planning table の link row を正本にします。

## 永続化と並行更新

`PlanningTable` は `workspaceId` / `recordKey` を primary key とし、次の row を保存します。

- `META`: planning schema version と Workspace graph revision
- `ENTITY#<id>`: planning entity
- `DEPENDENCY#<id>`: directed scheduling dependency
- `LINK#<teamId>#<workItemId>`: Work Item から Cycle / Milestone / Goal への link

すべての mutation は snapshot の `expectedRevision` を必須とし、認可に使った snapshot と mutation の revision を一致させたうえで、`META` の revision CAS と対象 row を同じ DynamoDB transaction で更新します。Stale write は `409 PlanningRevisionConflict` で拒否し、階層、dependency、link の部分更新を残しません。Canonical Work Item projection は強整合 read で取得します。Workspace member の role / status 更新と Planning scope が参照する Team / Project の archive は、事前検査した `META` revision を directory mutation と同じ transaction で一つ進めます。並行する Planning create / move とは一方だけが成功し、競合側は最新 snapshot で再検査します。

1 Workspace は metadata を含め 2,000 row、1 row は安全余裕を含む 300 KB、1 transaction は 100 item / 3 MB、API snapshot は4 MBを上限とします。Entity description は UTF-8 で 20 KB、status update は1件 8 KB・entity ごとに新しい順で32件までです。上限超過は commit 前に `413` で拒否し、response だけ失敗して revision が進む状態を作りません。

## 階層と roll-up

許可する基本階層は `Portfolio → Roadmap → Initiative → Goal/OKR` で、OKR は `Objective → Key Result` を表現できます。その下に `Phase → Milestone/Release` を配置します。Project 計画の実用性のため、Phase は Roadmap / Initiative の直下、Milestone / Release は Roadmap / Initiative / Goal の直下にも配置できます。Cycle と Portfolio は root です。Self reference、存在しないまたは archive 済みの親、循環は保存しません。親を archive する前に active な子を移動または archive する必要があり、dependency と Work Item link は履歴として保持します。

Automatic progress は、関連 Work Item と子孫の現在状態から on-read で決定します。`completed` は 100、`started` は 50、`backlog` / `unstarted` は 0 とし、`canceled` は分母から除外します。同じ Work Item が複数経路から辿れる場合も、ancestor ごとに一度だけ数えます。Manual progress を指定した entity は 0〜100 の保存値を使います。`rollupHealth` は自身と active な子孫の最も悪い health を返します。

## Cycle rollover

Cycle は date-only の baseline / forecast、cadence、Work Item 件数単位の整数 capacity、carry-over policy を持ちます。Link と rollover は capacity 超過を commit 前に拒否します。Rollover は source / target Cycle が同じ Team / Project scope と cadence で、target の baseline / forecast が source より後に始まることを確認し、source を `completed` にします。

- `move-incomplete`: `completed` / `canceled` 以外の Work Item link を target Cycle へ移動
- `keep-incomplete`: 未完了 link を source Cycle に保持

Response は再計算済み snapshot と `movedWorkItemIds` / `retainedWorkItemIds` を返すため、同じ入力と revision から結果を再現できます。

Rollover は canonical Work Item revision を Planning META と同じ DynamoDB transaction で条件検証します。Transaction の100 item上限に合わせ、一度に検証できる source link は49件までです。削除済み・閲覧不能の Work Item が link された場合は rollover を fail-closed にし、Workspace owner / admin が既存の DELETE API で stale link を清掃してから再実行します。Work Item の Project が変わった link は snapshot / roll-up から除外し、新しい Project scope へ明示的に再 link するまで rollover を拒否します。

## Timeline と critical path

Dependency は predecessor / successor の directed edge で、self edge、重複 edge、循環を拒否します。Critical path は dependency に参加する archive されていない entity の forecast（無い場合は baseline）の inclusive calendar day 数、dependency、lag から DAG の最長経路を算出します。Dependency に参加しない長期 Portfolio 等が scheduling path を隠すことはありません。Timeline 上の日付や dependency の変更後は、mutation response に再計算した critical path を含めます。

## 権限

- active Workspace member: Planning snapshot の参照
- Project / Team member: Work Item link と status update
- Project / Team manager: scoped entity、dependency、Cycle rollover、archive / duplicate / move
- Workspace owner / admin: Workspace scope の Portfolio / Roadmap 等の管理
- guest: mutation 不可

Move、dependency、link では起点と終点の両方を検証します。Move は対象 entity と active な全子孫の Team / Project scope を一つの transaction で変更し、archive 済み子孫は履歴上の scope を保持します。Project / Team member は、アクセス可能な Work Item を Workspace scope の戦略 Goal / OKR に link できます。Workspace scope の status update と構造変更は owner / admin に限定します。Entity owner は active Workspace member に限り、member の無効化前に所有 entity を移譲または archive する必要があります。Active entity または保存済み Work Item link が参照する Team / Project の archive は、entity を移動または archive し、link を解除するまで拒否します。権限確認に失敗した場合、Planning store の mutation は呼び出しません。
