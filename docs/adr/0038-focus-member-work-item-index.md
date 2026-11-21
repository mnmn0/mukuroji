# 0038. Focus が読む Work Item を、メンバーごとの index row と relation の端点に絞る

- 状態: 提案
- 日付: 2026-11-21
- 関連: Issue #459、Issue #367、PR #595、Issue #365、Issue #637、[ADR 0013](0013-data-migration-runner.md)、
  [ADR 0031](0031-data-migration-lambda-and-operator-proof.md)、[docs/data-migration.md](../data-migration.md)

## 背景

Focus（`GET /api/focus`）は、1 回の表示ごとに閲覧できる Team の Work Item partition をすべて強整合で読んでいる。
Home・Dashboard・Team の概要も同じ Focus を読むので、表示の回数だけ Workspace 全体の Work Item を読み直す。
閲覧できる Work Item が 5,000 件・Team が 50 の Workspace では、1 回の表示が約 2,500 RRU（1 件 2 KB として
約 10 MB）になり、上限の 10,000 件を超えると 413 で Focus が出ない。

Focus の queue に載るのは次の Work Item だけである（`server/src/modules/focus/focus-queue.ts`）。

1. 閲覧者が責任者（`assigneeUserId`）または Contributor（`contributorAssignments[].memberUserId`）のもの。
2. 閲覧者への review 依頼（承認の reviewer）か mention（Inbox の通知）があるもの。
3. 上の Work Item の blocker（同じ Team の `blockedBy` relation と、Planning の Work Item 依存の先行側）。

これとは別に、`metrics.blocked`（Home などの「要確認」）は「閲覧できる未完了の Work Item のうち、閲覧できる未完了の
blocker を持つものの数」を Workspace 全体で数えている。blocker を持てるのは `blockedBy` relation の起点か、
Planning の Work Item 依存の後続側だけである。

2 と 3 と blocked 件数は、すでに読んでいる source（Inbox、承認、Team ごとの relation graph、Planning）から
Work Item の key が分かる。1 だけは、今の table に担当者や Contributor で引ける key がないため、Team partition を
全件読むしかない。

制約は次のとおり。

- 常時の固定費を増やさない（新しい table・stream・常駐 worker を足さない）。
- Focus の結果（queue と blocked 件数）と権限の絞り込みを変えない。
- Contributor は 1 件に最大 20 人いる。DynamoDB の GSI は配列を key にできない。
- 既存の row にも index を付ける必要がある。#365 / #637 の migration runner は「1 row の schema version を
  `N` から `N + 1` に上げる」契約で、別の row を作る移行は対象外としている。

## 決定

### メンバーごとの index row

- Work Items table に、Work Item の責任者と Contributor 1 人ごとに 1 行の index row を置く。
  - partition key `directoryTeamId`: `<Workspace ID>#member-work-items#<正規化した member key>`
  - sort key `issueId`: `<encodeURIComponent(Team ID)>#<encodeURIComponent(Work Item ID)>`
  - 属性: `entryType: 'work-item-member-index'`、`schemaVersion: 1`、`directoryId`、`memberKey`、`teamId`、`workItemId`
  - `sortOrder`、`updatedAt`、`directoryProjectId`、通知 index の属性を持たないので、既存のどの GSI にも載らない。
    partition key は `#team#` を含まないので Team partition の読み取りにも混ざらない。tenant の export と削除は
    `<Workspace ID>#` の prefix で選ぶため、そのまま対象に入る。
- index row は「この member がこの Work Item に関わっているかもしれない」という候補でしかない。Focus は index row で
  見つけた Work Item を必ず本体の row から強整合で読み直し、責任者・Contributor・archive・権限をこれまでどおり判定する。
  そのため、古い index row が残っても queue には出ない（読む量が少し増えるだけ）。逆に index row が欠けると queue から
  漏れるので、書き込み側は欠けないことを優先する。
- 書き込み: `createTeamIssue` は責任者と Contributor の index row を、`updateTeamIssue` は責任者か Contributor が
  変わったときに増えた member の Put と減った member の Delete を、`deleteTeamIssue` は全員分の Delete を、Work Item 本体と
  同じ TransactWriteItems の末尾に足す（条件なし）。責任者と Contributor を書き換える経路はこの 3 つだけ
  （`server/src/modules/work-items/adapter-out/dynamodb/work-item-client.ts`）。計算は
  `work-items` module の `work-item-member-index.ts` に 1 か所だけ置く。
- 読み取り: Focus は閲覧者の member key の partition を強整合の Query で読む（base table なので強整合で読める）。
  1 回に読む index row は 5,000 件までとし、超えたら今と同じ 413 にする。

### Focus の読み取り

Focus は次の Work Item だけを BatchGetItem（強整合、100 件ずつ）で読む。

- 閲覧者の index row が指す Work Item（上の 1）。
- 閲覧者の mention 通知と reviewer の承認が指す Work Item（上の 2）。
- 閲覧できる Team の relation graph にある `blockedBy` の両端と、Planning の Work Item 依存の両端（上の 3 と blocked 件数）。

読んだ row は今と同じ `filterAccessibleTeamIssues` で Team・Project の閲覧権限を確かめ、archive 済みと削除済みを除いてから、
これまでと同じ `createFocusQueue` に渡す。queue と blocked 件数の計算は変えない。relation graph は「閲覧できる
Work Item がある Team」ではなく「閲覧できる Team」すべてについて読む（今も Team 数だけ読んでいる）。
Planning の依存の端点は、未フィルタの `getAuthorizationState` から取る。

blocked 件数は別の counter を持たず、この端点の読み取りで数える。counter にすると、先行側の状態の変化、relation の追加と削除、
Project の付け替えのたびに後続側の counter を直す必要があり、閲覧権限ごとの数え分けもできないため。

### 既存 row の backfill

- migration runner に、行を書き換えずに「派生 row」を作る種類（`kind: 'derive'`）を足す。定義は `classify`（`pending` /
  `unrelated` / `unknown`）と `derive(row)`（作る row の一覧、純粋・決定的）を持つ。runner は `pending`（派生元）の row ごとに、
  元の row の revision を確かめる ConditionCheck と派生 row の Put を 1 つの TransactWriteItems で書く。revision が
  変わっていたら読み直して作り直す（今の `replaceRow` と同じく 3 回まで）。checkpoint・lease・書き込み budget・
  dry run・Lambda での実行と operator proof は今の runner をそのまま使う。
- verify は派生元の row ごとに派生 row があることを確かめ、欠けがあれば失敗にする。
- 最初の定義は `0001-work-item-member-index`（`work-items` table）。Work Item 本体の row を `pending`、index row と
  key registry の row を `unrelated` にする。
- Lambda の role に、allowlist の table への `dynamodb:ConditionCheckItem` を足す（Put と同じ table だけ）。
- 手順: この PR の deploy 後、`bun run data:migrate:aws run --function-name <name> --migration 0001-work-item-member-index --apply`
  を実行し、続けて `bun run data:migrate:aws verify --function-name <name> --migration 0001-work-item-member-index`
  を実行する（verify に `--apply` は付けない）。
- verify は派生 row が一致しないとき派生元を強い整合性で読み直す。revision が変わっていれば新しい row から派生し直して確かめ、
  変わっていなければ失敗のままにする。
  deploy から backfill が終わるまでの間は、index row のない既存の Work Item が「担当・Contributor だから」という理由では
  Focus に出ない（mention・review・blocker では出る）。この時点で本番環境はまだないので、初回 deploy の環境では
  この間は生じない。

## 検討した選択肢

- 選択肢 A（採用）: メンバーごとの index row を Work Item と同じ transaction で書き、Focus は index と既存 source の
  key だけを BatchGet する。
  利点: 読む量が「自分に関係する Work Item と relation の端点」に比例する。強整合で読める。新しい table・stream・GSI が要らない。
  欠点: 責任者や Contributor を書き換える経路を増やすときに index の維持を忘れると Focus から漏れる。1 回の更新の
  transaction に最大 42 件（21 人の入れ替え）の action が増える。完了した Work Item の index row も残るので、
  長く使うと読み直す件数が増える。
- 選択肢 B: 責任者の GSI（`assigneeUserId` を key にする）。利点: 書き込み側の変更がいらない。
  欠点: Contributor を引けない。GSI は結果整合なので、担当を付けた直後の Focus に出ないことがある。
- 選択肢 C: DynamoDB Streams と Lambda で index を作る。利点: 書き込み経路の漏れがない。
  欠点: stream・Lambda・失敗時の再処理が増える。結果整合。既存 row の backfill は別に要る。
- 選択肢 D: メンバーごとに Focus の結果そのものを持つ。利点: 表示が最も安い。
  欠点: mention・承認・Planning・policy・snooze の変化をすべて反映し直す必要があり、計算を 2 か所に持つことになる。
- 選択肢 E: blocked 件数を Team ごとの counter にする。欠点は「Focus の読み取り」に書いたとおり。

## 費用の目安

東京 region の on-demand（読み取り 100 万 RRU あたり約 $0.14、書き込み 100 万 WRU あたり約 $0.71）、Work Item 1 件 2 KB、
5,000 件・50 Team・利用者 50 人・1 人 1 日 20 回の表示（月 30,000 回）で見積もる。

| 項目 | 今 | この ADR の後 |
| --- | --- | --- |
| Focus 1 回の Work Item 読み取り | 約 2,500 RRU（全件） | 約 50〜250 RRU（関係する 50 件と relation の端点 200 件） |
| Focus の月の読み取り | 約 7,500 万 RRU（約 $10.7） | 約 150〜750 万 RRU（約 $0.2〜1.1） |
| 書き込み | なし | 作成 1 件あたり（責任者 + Contributor）× 2 WRU、担当の変更時だけ差分 × 2 WRU。月 2,000 件作成で約 1 万 WRU（約 $0.01） |
| 保存 | なし | index row 1 行 約 200 B。5,000 件 × 2 人で約 2 MB |
| backfill | なし | 5,000 件の Scan（約 2,500 RRU）と index row 約 1 万行の transaction 書き込み（約 4 万 WRU、約 $0.03） |

relation の端点の読み取りは relation の数に比例する。relation がほとんどない Workspace では、関係する Work Item の分だけになる。

## 結果

- 5,000 件・50 Team の Workspace でも、Focus の 1 回の表示が Workspace 全体の Work Item を読まない。
- queue と blocked 件数の結果、権限の判定は変わらない。利用者から見える挙動は変わらないので、利用者ガイドは更新しない。
- Work Item の責任者・Contributor を書き換える経路を足すときは、`work-item-member-index.ts` の差分を同じ transaction に入れる。
- 例外は削除だけとする。削除 transaction が DynamoDB の上限 100 action を超える場合（削除の fence が多いとき）は、
  index row の Delete を commit 後に別の transaction で行う。この transaction は canonical row がまだ無いことを
  ConditionCheck で確かめるので、同じ ID で作り直された Work Item の index row は消さない。`TransactWriteItems` なので
  Planning fence の barrier も通る。一時的な失敗は backoff して最大 5 回まで試し、それでも失敗したら削除は成功のままにする。
  残った index row は存在しない Work Item を指すだけで、Focus の参照読み取りが除くので表示は変わらない。ただし
  メンバーごとの読み取り上限（5,000 行）には数えられる。残るのは、fence が約 80 件ある削除で、掃除が 5 回とも失敗した
  ときか、掃除の前に同じ ID の Work Item が別のメンバーで作り直されたときだけなので、上限に届くほど溜まるとは見込まない。溜まった場合は index row を掃除する移行を足す。
- 完了した Work Item の index row が溜まって読み直す件数が増えたら、index row に「完了した時刻」を持たせて Query で除く。
- `docs/data-migration.md` に `derive` の契約を書き足す。ADR 0013 の「別の row を作る移行は対象外」は、この ADR の
  `derive` の範囲（同じ table に、元の row から決まる row を作るだけ）で緩める。
