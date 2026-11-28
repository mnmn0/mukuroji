# 0115. 工程を Workspace の tenant profile で定義し、作業区分・ワークフローステータス・Agent Run を工程に対応づける

- 状態: 提案
- 日付: 2026-11-28
- 関連: Issue #831、ADR 0047、ADR 0061、ADR 0103、ADR 0108

## 背景

#831 は、要件定義・設計・実装・レビュー・評価のような工程ごとに、人の工数（人件費）、Agent Run の
AI コスト、待ち時間を比べたいという要望である。工数には作業区分（ADR 0047）があり、Work Item には
ワークフローステータスがあり、Agent Run にはトークン使用量（ADR 0061）があるが、どれも工程を持たない。
11/28 のコメントで、ステータスごとの滞在時間と、プルリクエストの間隔（作成 → 最初のレビュー → 承認 → マージ）も
求められた。GitHub の取り込み（#827）はまだないので、間隔は ADR 0103 で保存している外部 artifact の状態から出す。

## 決定

- 工程は Workspace の設定とし、tenant profile に
  `workPhases: { phases: { key, label?, active }[], categoryPhases: Record<作業区分 key, 工程 key> }` として保存する。
  変更は既存の `PATCH /api/tenant/profile`。保存していない Workspace は既定の 5 工程
  （`requirements`・`design`・`implementation`・`review`・`evaluation`）で、既定の作業区分 `design`・`implementation`・`review` は
  同じ名前の工程に対応する。
- 検証は `contracts` の `readWorkspaceWorkPhaseSettings` が持つ。key の形と予約 key（`no-phase`・`uncategorized`・`no-work-item`）の扱い、
  1〜30 工程、名前 60 文字、既定でない工程の名前は必須、という作業区分と同じ規則にする。`categoryPhases` の工程は一覧にあるものだけ。
  工程は消さずに `active: false` で使用停止にし、保存済みの key を落とす変更は `400 WorkPhaseRemoved` で拒否する。
- 全メンバーが工程を読めるよう、認証だけの `GET /api/workspace/work-phases` を足す。
- ワークフローステータスは任意の `phaseKey` を持つ（Work Item の設定に保存）。既定のワークフローは `in-progress` を実装、`review` をレビューにする。
  保存時は key の形だけを確かめ、Workspace の一覧にあるかは見ない（設定は Workspace と Team で別に保存されるため）。
- Agent Run は開始時の Work Item のステータス ID を `startWorkflowStatusId` に保存する。工程は読むときに Team の今の設定から引く。
  ステータスの対応を直すと、過去の Run もその工程に数え直される。
- 人件費は工数の集計の `groupBy=phase`。entry の作業区分から `categoryPhases` で工程を引き、区分がないか対応がない entry は `no-phase`。
  費用の扱い（Team manager だけ）は既存の集計と同じ。
- AI コストは Factory 分析の `usage.phases`。Run ごとの使用量を開始時ステータスの工程で足す。費用を見られる人は既存の usage と同じ。
- 待ち時間は Analytics の `status-time` metric。Work Item の履歴から各ステータスにいた区間を作り、未着手・進行中のカテゴリーの時間を足す。
  `groupBy` が `status` ならステータス ID、`phase` ならステータスの工程で、時間を過ごしたステータスごとに分ける。
  それ以外の dimension は他の metric と同じく `asOf` の状態で分ける。`phase` で分けられるのは `status-time` だけ。
  Analytics の履歴は監査 diff から作るので、`workflowStatusId` の変更も履歴に残すようにした。
  Work Item history row（ADR 0042）は `schemaVersion` を 2 に上げた。`workflowStatusId` の変更を持たない version 1 の row は
  読まずに entity timeline から読み、次の event で timeline から作り直す。Row は audit の projection なので data migration は作らない。
- プルリクエストの間隔は Factory 分析の `pullRequestLeadTimes`。ADR 0103 で照会済み（`verified`）のプルリクエストの状態に、
  作成・最初のレビュー・承認の時刻を足して保存する（作成者自身のレビューと下書きのレビューは数えない。承認は取り消されていないもののうち最も早い時刻）。
  区間の終わりが期間内のものの中央値を出す。提供元への追加の照会はしない。

## 検討した選択肢

- Run に工程を保存する: 読むときに引く必要がないが、ステータスの対応を直しても過去の Run は直らない。設定の直し忘れを後から正せる方を選ぶ。
- 作業区分の定義（ADR 0047）に工程を持たせる: 区分と工程の保存が一つになるが、区分は工数のための一覧で、工程はステータスと Run にも使う。
  工程の側に対応表を持たせた。
- 待ち時間を別の集計 API にする: 新しい API と画面が要る。Analytics の metric にすればフィルターと保存済みレポートをそのまま使える。
- CI の待ち時間も出す: check の時刻を保存していないので、#827 の GitHub 取り込みで扱う。

## 結果

- 新しい table・index・queue はない。Analytics で `status-time` を使う query は、関わる Team の Work Item 設定と tenant profile を読む。
  Factory 分析は Team の設定とプルリクエストの状態を読む回数が増える。
- この変更より前に書かれた Analytics の履歴にはステータスの変更がないが、本番はまだ deploy していない。
- Public API の Work Item Type 一覧はステータスを `id`・`name`・`category`・`sortOrder`・`color` だけに絞って返す（OpenAPI の定義どおり）。
- 更新した文書: `docs/guide/admin.md`、`docs/guide/pm.md`、`docs/guide/coding-agent.md`、`docs/time-tracking.md`、`docs/analytics.md`。
