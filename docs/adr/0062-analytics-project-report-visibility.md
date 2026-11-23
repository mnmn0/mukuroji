# 0062. Analytics report の共有範囲に Project を足し、Team と Project の組で読み書きを判定する

- 状態: 提案
- 日付: 2026-11-22
- 関連: Issue #401、[ADR 0021](0021-analytics-delivery-notification-outbox.md)、
  [ADR 0064](0064-analytics-recipient-delivery-index.md)、[docs/analytics.md](../analytics.md)

## 背景

保存済み Analytics report の共有範囲は個人・Team・Workspace 全体の 3 つだった。#401 は Project の
メンバーだけで見る report を求めている。Team 共有では、同じ Team の別の Project のメンバーにも見えてしまい、
作成・変更も Team manager に限られる。

Project ID は Team をまたいで同じ値になりうる（Project directory の Project は Team ごとに持つ）。
Project だけで判定すると、別の Team の同名 Project を読める人にも見えてしまう。

## 決定

- 共有範囲に `project` を足す。`project` の report は `teamId`（Project を所有する Team）と `projectId` の
  両方を持つ。ほかの共有範囲は `projectId` を持たず、`teamId` は `team` と `project` だけが持つ。
  保存時と読み込み時の両方で検査する。
- 読めるのは、その Team と Project の組を今読める member（Work Item の saved view と同じ
  `taskViewAccess.projectScopeKeys`、Team 付きの key）。report 一覧、report を使う query と export、
  snapshot、「自分への配信」、Inbox の表示は同じ `canReadAnalyticsReport` を通る。
- 作成・変更・削除は、その Project の manager（`requireProjectPermission(..., 'manager', teamId)`）か、
  Enterprise で Team または Workspace の `teams.manage` を持つ人。作るときは Project がその Team に
  あることを確かめ、なければ 404 にする。
- 定期配信は、配信時点で受信者がその Team の Project を読めるときだけ snapshot と通知を作る。
  Team を持たない旧形式の Project 権限は、その Project ID が 1 つの Team にしかないときだけ効く。
  同じ Project ID が複数の Team にあるときは、どの Team でも効かせない（#594 と同じ fail-closed）。
  配信の集計に入れる Work Item も同じ Team 付きの組で選び、別 Team の同じ ID の Project の Work Item は入れない。
  これは Project report に限らず、すべての定期配信に効く。
  通知の event には `teamId` と `projectId` を載せ、projection と外部送信の直前に、ほかの Project 単位の
  通知と同じ規則で受信者の Project access を確かめ直す。
- Web の report builder は共有範囲に「プロジェクト」を出し、Team を選ぶとその Team の Project だけを選べる。

## 検討した選択肢

- Team 共有の report に Project の filter を付けて代わりにする: 見える人は Team のまま変わらず、
  Project の外に見せない要件を満たさない。
- `projectId` だけで判定する: Team をまたいで同じ Project ID があると、別の Team の Project を読める人に見える。
- 複数の Project に共有できるようにする: 判定と UI が複雑になる。必要になったら別に決める。
- Team と Project の組で判定する（採用）: 既存の saved view と同じ key を使え、通知も既存の Project 単位の
  規則に乗る。

## 結果

- Project のメンバーだけで report を共有でき、その Project の manager が管理できる。
- report の owner でも、その Project を読めなければ report を開けない。Project を削除すると、Team を削除した
  Team report と同じく、誰も開けなくなる。
- 既存の report は変わらない。初回 deploy 前なので migration は不要。
- 更新した文書: [docs/analytics.md](../analytics.md)、[docs/guide/pm.md](../guide/pm.md)。
