# 0033. Project ID を Workspace ごとの予約 row で一意にし、衝突したら別の ID で作り直す

- 状態: 提案
- 日付: 2026-11-21
- 関連: Issue #643、[ADR 0028](0028-project-permission-team-qualified-match.md)、[ADR 0009](0009-directory-display-order.md)

## 背景

Project の ID は作成時に名前から作る（ASCII の名前なら slug、それ以外は `project-<random>`）。使われていない ID は
作成前に読んだ directory の snapshot で決めるが、Project 行の sort key は
`<Team の並び順>#<Project の並び順>#PROJECT#<projectId>` で Team の並び順を含む。そのため 2 人がほぼ同時に
別の Team で同じ名前の Project を作ると、key は衝突せず、同じ ID の Project が 2 つ commit される。

一方、Project メンバー行（`PROJECT_MEMBER#<projectId>#<memberKey>`）、watch、通知、検索は Project ID だけで
引く。ID が重なると 2 つの Project のメンバーが混ざり、ADR 0028 の fail-closed で作成者も自分の Project を
開けなくなる。初回 deploy の前に塞いでおきたい。

## 決定

- Project を作る transaction に、project directory table の sidecar row を 1 つ足す。
  - partition key `directoryId`: `PROJECT_ID#<encodeURIComponent(workspaceId)>`
  - sort key `entryKey`: `PROJECT#<projectId>`
  - 属性: `entryType = project-id`、`workspaceId`、`projectId`、`createdAt`
  - `attribute_not_exists` 付きの Put にする。Project 行・作成者のメンバー行と同じ transaction で commit する。
- 予約 row が理由で失敗したら（別の Team が同じ ID を先に取った `ConditionalCheckFailed`、または同時に書いている
  `TransactionConflict`）、directory を強整合で読み直し、
  その ID を除いて別の ID を選び、最大 3 回まで作り直す。3 回とも取れなければ 409 を返す。
- 冪等キーから ID が決まる作成（template の適用など）は ID を変えられないので、作り直さずに 409 を返す。
  同じ要求の再送は既存の Project を返す既存の経路で扱う。
- 予約 row は Team 移動・名前変更・archive では変えない（Project ID は作成後に変わらない）。Project の
  物理削除はないので、予約を解放する経路も持たない。
- 既存の重複は cross-domain integrity check で見つける。同じ Workspace の同じ Project ID が別の Team に
  ある場合を `DUPLICATE_RECORD` として失敗にする。予約 row 自体も正しい形の補助 row として検査する。

## 検討した選択肢

- **予約 row を directory の partition（`directoryId = workspaceId`）に置く**：tenant 削除の対象に自然に
  入るが、directory partition を読む全ての箇所が未知の row を invalid として扱うので、それらを全部直す
  必要がある。Project code の予約（`PROJECT_CODE#…`）と同じ sidecar partition に揃えた。
- **Project 行の key から Team の並び順を外して ID だけにする**：ID は一意になるが、表示順の設計（ADR 0009）と
  既存の全ての key・query を変えることになり、変更が大きすぎる。
- **ID を常に random にする**：衝突はほぼ起きないが、ASCII 名から読める ID を作る既存の挙動と URL が変わる。
  random でも確率的にしか一意にならない。

## 結果

- 全ての API がこの版で Project を作る限り、同じ ID の Project が 2 つ commit されることはなくなる。同時に作った
  片方は `web-2` のような別の ID になる。予約 row を書かない前の版が同時に動く間は保証できない。今は deploy 済みの
  環境がないのでその期間はない。将来この版より前へ rollback する場合は、戻している間に別 Team で同名の
  Project を作ると ID が重なりうる（メンバー・watch・通知が混ざる）。その間に作られた重複は integrity check の
  `DUPLICATE_RECORD` で見つける。
- 候補 ID を決める directory の読み取りは強整合にする。予約 row のない既存 Project の ID を見落とさないため。
- Project 作成の transaction が 1 項目増える（上限 100 に対して余裕がある）。
- 初回 deploy 前の変更なので、既存 Project の予約 row を埋める backfill は用意しない。予約 row のない
  既存 Project の ID は、作成時の snapshot で除外されるので新しい Project と重ならない。
- tenant 削除は今の実装で `directoryId = workspaceId` の partition だけを消すため、`PROJECT_CODE#…` などの
  sidecar と同じく、この予約 row も残る。sidecar をまとめて消す対応は別に扱う。
