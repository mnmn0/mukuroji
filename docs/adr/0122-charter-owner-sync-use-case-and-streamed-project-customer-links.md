# 0122. Charter owner の同期を Planning の use case に置き、Project ごとの顧客リンクは件数上限なしで数える

- 状態: 提案
- 日付: 2026-11-28
- 関連: ADR 0084、PR #786 の CodeRabbit 指摘

## 背景

PR #786 で次の 2 点が残っていた。

- Charter の owner が変わったとき health update の owner を移す処理（ADR 0084）は、権限と recipient の確認、
  transaction 条件の組み立て、revision 競合時の再試行を Planning の route module の中で行っている。charter の route は
  この関数を Planning の route module から直接 import しており、route が use case を持っている。
- `GET /api/customers/project-links`（Project ごとにつながる顧客の一覧）は、Customer と Request の row を合わせて
  10,000 件まで memory に読み込み、超えると 413 を返す。一覧は Project の概要と一覧の画面を開くたびに読まれるため、
  上限を超えた Workspace では顧客リンクがずっと表示されない。

## 決定

- 同期の流れ（target の読み取り、変更権限、owner・escalation・確認者の確認、charter が別の owner に変わった場合の打ち切り、
  transaction 条件の組み立て、revision 競合時の 3 回までの再試行、失敗の記録）を
  `modules/planning/application/charter-update-owner-sync.ts` の `syncCharterUpdateOwner` に移す。
  Planning の読み取り、権限確認、条件 row の生成、cadence の書き込みは port として受け取る。
- 権限確認の実装（`requirePlanningUpdateTargetPermission` など）は cadence endpoint と共有しているため、route module が
  port の実装として渡す。拒否は port が `false` / `undefined` に変え、それ以外の失敗は throw する。
- 顧客リンクの一覧は、Request の row と Customer の row を prefix ごとに page で読み、Project と Customer の組ごとの件数と、
  リンクのある Customer の名前だけを持つ。row 数の上限は設けない。保持するのはリンクの数に比例する量だけになる。
- 読み始めと読み終わりの Workspace の META row（revision と進行中の操作）が一致しなければ 3 回まで読み直す。
  削除・merge の途中の Customer は従来どおり除き、保持期限を過ぎた Customer は保存前でも伏せた名前で返す。
  この読み取りは伏せた結果を保存しない（次の通常の読み取りや保持期限の処理が保存する）。

## 検討した選択肢

- **同期を route に残す。** 変更は要らない。ただし charter の route が Planning の route module に依存し続け、
  同期の分岐を HTTP を通さずに確かめられない。
- **Project と Customer の組ごとの投影 row を持つ。** 読み取りはリンクの数だけで済む。ただし Request の作成・リンク・
  merge・削除・保持期限のすべてで投影を更新し、既存 row から派生 row を作る data migration も要る。
- **一覧の読み取りに上限なしの bounded read を使う。** 変更は小さい。ただし全 row を memory に持つため、Workspace の
  大きさに比例して Lambda の memory を使う。

## 結果

- Charter owner の同期は fake の port で検証でき、route は入力と principal の取得、port の実装、結果の返却だけを持つ。
- 顧客リンクの一覧は Workspace の row 数で失敗しない。読み取りの時間と費用は Request と Customer の row 数に比例する。
  画面の表示が遅くなるほど大きくなったら、投影 row を改めて検討する。
