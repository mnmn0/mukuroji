# 0097. OrgUnit（部門）で Team を束ね、部門のロールは配下の Team scope に展開して評価する

- 状態: 提案
- 日付: 2026-11-24
- 関連: Issue #346

## 背景

数十の Team を持つ組織では、事業部や部門の単位で Project と Work Item を集計し、部門長に配下の Team だけを
管理させたい。これまでの Enterprise ロールの scope は Workspace / Team / Project の3段で、部門長に権限を渡すには
Team ごとに割り当てるか、Workspace 全体に広げるしかなかった。組織変更で Team の所属が変わるたびに、Team ごとの
割り当てを付け替える必要もあった。

## 決定

- Workspace に OrgUnit の木（親子、最大 6 階層、200 件）と、Team の所属（1 Team は 0 または 1 の OrgUnit）を持たせる。
  - 木と所属は Workspace ごとに 1 行の sidecar として Project Directory table に保存する。
    partition key `directoryId` は `ORG_STRUCTURE#<encodeURIComponent(workspaceId)>`、sort key `entryKey` は `STRUCTURE`、
    `entryType` は `'org-structure'`。属性は `workspaceId`、`orgUnits`、`teamAssignments`、`revision`、`updatedAt`。
  - 読み取りは `GET /api/org-structure`（guest は不可）、更新は `PUT /api/org-structure` で木と所属をまとめて置き換える。
    更新には `workspace.manage` と Workspace 管理者であることを求め、OrgUnit のロールで自分の範囲を広げられないようにする。
  - 更新は `expectedRevision` で compare-and-swap し、最初の保存は `attribute_not_exists(entryKey)` を条件にする。
    行の Put と監査 event `org-structure.updated` は同じ transaction で書く。監査には OrgUnit と所属の件数だけを残し、
    監査行の大きさの上限を超えないようにする。
  - 同じ transaction で、`Idempotency-Key` と request fingerprint を結ぶ receipt を Team 管理と共有の
    `TEAM_GRANT_REQUEST#<encodeURIComponent(workspaceId)>` partition に `attribute_not_exists(entryKey)` で書く（ADR 0080）。
    応答を失った後の同じ key・同じ入力の再送は、receipt を見つけた場合だけ保存済みの構造を返す。同じ key で入力が異なる場合は
    `IdempotencyKeyConflict`、receipt がない古い revision は `OrgStructureConflict` にする。
  - 所属させる Team は、アーカイブ済みを含めて Workspace に存在するものに限る。
- Enterprise のロール scope に `org-unit` を加え、組み込みロール `org-unit:manager`（Team管理者と同じ権限）と
  `org-unit:viewer`（閲覧のみ）を加える。メンバーへの直接割り当てと Directory group mapping の両方で使える。
  SCIM の group には、group mapping を通して OrgUnit のロールが付く。
- 認可の評価では、OrgUnit の scope を、その OrgUnit と配下の OrgUnit に所属する**有効な** Team の Team scope に展開してから
  既存の評価器へ渡す。展開は Project scope の Team 解決と同じ箇所（directory の一貫性のある読み取り）で行う。
  評価器（`scopeMatches`）は展開されていない `org-unit` scope に一致しない。構造を読めない経路や展開しない経路では
  OrgUnit のロールは何も許可しない（deny by default）。構造がない、OrgUnit が消えた、有効な Team がないなどで
  展開できない scope は、展開せずに残す。何にも一致しないが割り当てとしては数えるので、そのメンバーが
  元の Workspace ロールの権限に戻ることはない。
- 展開に使った構造の revision を principal に記録し、更新系の transaction に構造の行への条件
  （その revision のまま、または行がないまま）を加える。認可から commit までの間に管理者が Team を部門から
  外すと、部門のロールで許可した更新は失敗する。条件を加えるのは、Enterprise CONTROL の revision で
  fence している既存の経路（呼び出し元の認可条件、Work Item・文書・curated context・AI assistance の
  認可 snapshot）と同じ箇所。
- 部門別の集計は、既存の Team ごとの portfolio 読み取りを Web で OrgUnit の配下ごとに合計する。新しい集計 API は作らない。
- テナント削除では、既存の sidecar と同じく Workspace ごとの partition を削除対象の末尾に加える。データ整合性検査では
  `org-structure` 行を既知の補助行として検証する。

## 検討した選択肢

- 選択肢 A（採用）: 木全体を 1 行に保存し、OrgUnit の scope を評価前に Team scope へ展開する。
  - 利点: 木の整合性（循環、深さ、所属の一意性）を 1 回の条件付き書き込みで保てる。評価器は Team scope の判定だけを持ち続け、
    Team の所属を変えれば部門のロールの効く範囲も次の評価から変わる。
  - 欠点: 1 行の大きさで OrgUnit と所属の件数に上限がある。展開に構造の読み取りが 1 回増える。
- 選択肢 B: OrgUnit と所属をそれぞれ別の行に保存する。
  - 利点: 件数の上限が緩い。
  - 欠点: 木の付け替えが複数行にまたがり、循環や所属の重複を防ぐには transaction の大きさと条件が複雑になる。
- 選択肢 C: OrgUnit のロール割り当てを保存時に Team ごとの割り当てへ展開する。
  - 利点: 評価器を変えなくてよい。
  - 欠点: 所属の変更のたびに割り当ての付け替えが要り、付け替えの失敗で権限が残る。

## 結果

- OrgUnit のない Workspace は、構造の行がないので空の構造として扱われ、これまでと同じに動く。
- 部門管理者は、配下の有効な Team とその Project にだけ Team管理者と同じ権限を持つ。所属から外した Team や
  アーカイブした Team には効かない。
- Realtime、Webhook の認可、collaboration projection、文書配信の評価器は OrgUnit の scope を展開しないので、
  OrgUnit のロールだけを持つメンバーにはこれらの経路で権限が出ない（安全側）。展開は後続で加える。
- Service account の scope に OrgUnit は使えない。
