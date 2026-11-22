# 0049. メンバーへの role 割り当てと Workspace role の変更を、相手側 table の条件付き書き込みで直列化する

- 状態: 提案
- 日付: 2026-11-22
- 関連: Issue #429、ADR 0023

## 背景

ADR 0023 で、member 個人への direct assignment は enterprise identity table に、Workspace role と
status は Workspace access table に置いた。どちらの API も相手側の table を読んで判定するが、書き込みの
条件は自分の table だけだった。そのため次の 2 つの経路で、判定に使った値が書き込みまでに変わり得た。

- 昇格と割り当て作成: `PATCH /api/workspace/members/:memberKey` は「direct assignment がない」ことを
  確かめて owner / admin にする。同時に割り当てが作られると、assignment で評価される owner / admin が
  できる（ADR 0023 の「結果」に残した範囲外）。割り当て作成側も、対象が owner / admin / guest でないことを
  読んだ時点の member で確かめるだけだった。
- 最後の assignment の解除と role 変更: 解除時の「戻る権限を caller が持つか」は読んだ時点の member の
  role で判定する。判定の後に role が上がると、caller が持たない権限が戻る（role を変える再有効化も同じ）。

## 決定

- 割り当ての作成と解除は、route が判定に使った Workspace member の version を enterprise identity の
  checkpoint transaction に `ConditionCheck` として加える。Workspace access の member record は role と
  status の変更ごとに version が進むので、判定後の変更は transaction を取り消す。member record が
  なかった場合は「まだ存在しない」ことを条件にする。条件は Workspace access module が
  `createWorkspaceMemberVersionConditionCheck` として作り、key の形は Workspace access が持つ。
  失敗は `409 EnterpriseRoleAssignmentMemberChanged`（再読み込みして判定し直す）。
- Owner / admin への昇格は、route が direct assignment の有無を読んだ enterprise identity snapshot の
  CONTROL revision を、Workspace access の更新 transaction に `ConditionCheck` として加える
  （Triage などが使う CONTROL revision の fence と同じ形）。失敗は
  `409 WorkspaceMemberAuthorizationChanged`。Enterprise identity table のない local 構成では fence を付けない。
- Memory 実装の enterprise identity client は、member version の reader を渡されたときだけ同じ判定をする
  （テスト用）。

## 検討した選択肢

- 共有の authorization revision を 1 つ作り、両 table の書き込みで進める: 全 mutation の条件を
  変える必要があり、範囲が大きい。Issue #429 の「request 中の caller 権限の失効」と合わせて別に検討する。
- 昇格側も member version だけで守る（割り当て作成が member version を進める）: client が送る
  `expectedVersion` を推測されると、route の読み込みと書き込みの間に作られた割り当てを見逃せる。
  Route が読んだ enterprise state そのものを条件にする方が確実。
- 昇格を role の指定があるすべての PATCH で fence する: SCIM などの無関係な enterprise 変更で
  role 変更が 409 になりやすい。判定が enterprise state に依存する owner / admin への変更だけにした。

## 結果

- ADR 0023 に残した 2 table をまたぐ 2 つの競合は、どちらの順で commit しても後の書き込みが取り消される。
- 判定後に member や enterprise state が変わると利用者は 409 を受け、再読み込みが要る。
- Lambda の IAM は既に両 table への `TransactWriteItems` 内の `ConditionCheckItem` を許可しており、
  CDK の変更は要らない。
- 更新した文書: `docs/enterprise-identity.md`。
