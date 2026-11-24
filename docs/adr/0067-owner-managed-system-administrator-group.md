# 0067. system administrator の付与・解除を owner が画面から行い、Cognito group を正本のまま使う

- 状態: 提案
- 日付: 2026-11-23
- 関連: Issue #429, [ADR 0023](0023-member-direct-role-assignment.md), [ADR 0049](0049-member-role-assignment-cross-table-fences.md)

## 背景

system administrator（Team の作成・archive、全 Team・Project の管理）は、Cognito の `SystemAdminGroups`
（既定 `mukuroji-system-admins`）に入っている user である。API は request ごとに `AdminListGroupsForUser` で現在の
group を読み、worker も同じ判定を使う。初期 owner は stack が group に入れるが、2 人目の追加や交代は AWS CLI で
group を操作するしかなかった。#429 の完了条件「AWS の操作なしで管理者を追加・交代できる」を満たしていない。

## 決定

- system administrator の正本は Cognito group のままにする。API Lambda に
  `cognito-idp:AdminAddUserToGroup`、`cognito-idp:AdminRemoveUserFromGroup`、`cognito-idp:ListUsersInGroup` を
  user pool 限定で足す。API は既に `AdminCreateUser` や `AdminDeleteUser` を持つので、権限の幅は大きく変わらない。
- `PUT /api/workspace/members/:memberKey/system-administrator`（body `{ "systemAdministrator": boolean }`）を足す。
  付与は設定の先頭の group へ追加、解除は設定したすべての group から外す。
  - caller は Workspace の active な owner だけ。自分自身は変えられない（別の owner に頼む）。
  - 対象は同じ Workspace の active member で、Cognito user の directory 属性がこの Workspace と一致すること。
    別 Workspace に属する account を、この Workspace の owner が system administrator にできないようにする。
  - guest は付与できない。解除は guest でもできる。
  - すでに要求どおりの状態なら、audit event と `completed` の進捗 record を同じ transaction で書き、Cognito は
    変えない。同じ key の遅れた再送が再開されて、その間に別の owner がした変更を戻さないようにするため。
  - 所属 Workspace の確認は、記録済みの変更を再送で再開するときも Cognito を変える前に毎回行う。
- 監査と再送は管理者による password・MFA リセットと同じ仕組みを使う。`member.system-administrator-granted|revoked`
  の audit event と進捗 record を、actor（owner の version）と対象（active・version）の ConditionCheck と同じ
  transaction で書き、Cognito を変える直前に `applying`、変えた後に `completed` にする。同じ Idempotency-Key の
  再送は、完了済みなら何もせず、Cognito を変え始めた後なら繰り返さない。
- `GET /api/workspace/members/sign-in-security` の応答に `systemAdministratorMemberKeys` を足し、メンバー管理画面で
  system administrator を表示する。group を読めない場合は省き、一覧は出す。
- メンバー管理画面には、security 設定を読める caller に限り、個人に割り当てた role（ADR 0023）も role 名と scope で
  表示する。

## 検討した選択肢

- Cognito group をやめ、Workspace の member row か role assignment に system administrator の flag を持つ: IAM の
  追加は要らないが、API と 7 つの worker が持つ判定（`isSystemAdmin` と access token の group claim）をすべて
  書き換え、既存 row の移行と CDK の初期 owner 処理も変える必要がある。初回 deploy の前に入れる変更として大きい。却下。
- Workspace owner を system administrator とみなす: 追加の仕組みは要らないが、`cdk/README.md` は owner row を
  system-admin group の代わりにしないと決めており、owner を増やすと Workspace の管理権限まで広がる。却下。
- owner だけでなく system administrator 自身にも付与を許す: 交代は楽になるが、owner より強い操作を owner 以外が
  連鎖的に配れることになる。却下。

## 結果

- owner は AWS の操作なしで system administrator を追加・交代できる。付与と解除は監査ログに残る。
- API の IAM が group 操作 3 つの分だけ広がる。対象は user pool 1 つに限る。
- 解除は次の request から効く（request ごとに group を読むため）。発行済みの access token の group claim は
  残るが、API はそれを system administrator の判定に使わない。
- Owner の交代は、新しい owner を任命して system administrator にし、旧 owner を外す、を画面で行う。
