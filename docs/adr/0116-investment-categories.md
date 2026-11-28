# 0116. 投資区分を Workspace の tenant profile で定義し、Team ごとに Project と Work Item へ割り当てる

- 状態: 提案
- 日付: 2026-11-28
- 関連: Issue #836、ADR 0047、ADR 0054、ADR 0115

## 背景

#836 は、工数を新規開発・エンハンス・保守・運用・管理業務のような投資区分で分け、区分ごとの人月・割合・金額を
出したいという要望である。開発は資産計上（Capex）、運用と管理は費用（Opex）として、両者の合計も比べたい。
区分は Project に既定を持たせ、Work Item で上書きできるようにする。金額は Team の manager だけが見られ、
期間・Team・Project で絞り込めること。

工数には作業区分（ADR 0047）と工程（ADR 0115）があるが、どちらも「何の作業か」の区分で、「何への投資か」ではない。
同じ実装作業でも、新機能か保守かは Project や Work Item で決まる。

## 決定

- 投資区分は Workspace の設定とし、tenant profile に
  `investmentCategories: { categories: { key, label?, group, active }[], personMonthHours }` として保存する。
  `group` は `capex` か `opex`。変更は既存の `PATCH /api/tenant/profile`。保存していない Workspace は既定の 5 区分
  （`new-development`・`enhancement`・`maintenance` が Capex、`operations`・`management` が Opex）と、1 人月 160 時間を使う。
- 検証は `contracts` の `readWorkspaceInvestmentCategorySettings` が持つ。key の形、予約 key（`unclassified`・`capex`・`opex` など）、
  1〜30 区分、名前 60 文字、既定でない区分の名前は必須、少なくとも 1 区分は使用中、1 人月は 1〜744 の整数とする。
  区分は消さずに `active: false` で使用停止にし、保存済みの key を落とす変更は `400 InvestmentCategoryRemoved` で拒否する。
- 全メンバーが区分を読めるよう、認証だけの `GET /api/workspace/investment-categories` を足す。
- 割り当ては Team ごとの 1 行とし、工数の table に `TIME_INVESTMENT#<teamId>` として
  `{ projects: Record<Project ID, 区分 key>, workItems: Record<Work Item ID, 区分 key> }` を保存する。
  `GET` / `PUT /api/teams/:teamId/investment-assignments`。行は Team のすべての Project と Work Item の ID を含むので、
  読み書きとも Team 全体の manager だけ（それ以外は `403 InvestmentAssignmentsDenied`）。保存は全体の置き換えで、`expectedRevision` の楽観排他。監査 event `investment-assignments.updated` には
  変わった項目だけを残す。新しく割り当てる区分は使用中のものに限り、使用停止の区分は今その項目に付いている場合だけそのまま残せる。
  1 行が DynamoDB の上限に近づかないよう、Project は 200 件、Work Item は 800 件までにする。
- 工数の区分は読むときに決める。entry の Work Item に割り当てがあればそれ、なければ entry の Project の割り当て、
  どちらもなければ `unclassified`。割り当てを直すと過去の工数もその区分に数え直される（ADR 0115 の工程と同じ考え方）。
- 集計は工数の集計の `groupBy=investment`。新しい `filterProjectId` で 1 つの Project に絞り込める（集計と CSV の両方。
  Project を見られない人には `verifyProject` が拒否する）。期間と Team は既存の集計と同じ。
- 人月と割合、Capex・Opex の合計は Web が集計の分と Workspace の 1 人月の時間から出す。金額は既存の集計と同じく
  `costsRedacted` で、費用を見られる manager にだけ返す。

## 検討した選択肢

- entry に投資区分を保存する: 読むときに引く必要がないが、割り当てを直しても過去の工数は直らない。設定の直し忘れを後から正せる方を選ぶ。
- Project や Work Item 本体に区分を持たせる: Project と Work Item の schema と API、Public API が変わる。
  区分は工数の集計のためだけの情報なので、工数の側に Team ごとの割り当て表を持たせた。
- 作業区分（ADR 0047）に Capex・Opex を持たせる: 同じ作業区分でも投資区分は Project によって違うので表せない。
- Analytics の metric にする: Analytics の fact は Work Item の状態で、工数 entry を持たない。今回は工数の集計に入れ、
  Analytics への取り込みは工数を Analytics の fact に入れるときに扱う。

## 結果

- 新しい table・index・queue はない。工数の table に Team ごとの割り当て行が 1 つ増える。`groupBy=investment` の集計は
  tenant profile と割り当て行を 1 回ずつ読む。
- 割り当てのない工数は `unclassified` になり、Capex・Opex のどちらにも入らない。
- 更新した文書: `docs/time-tracking.md`、`docs/guide/admin.md`、`docs/guide/pm.md`。
