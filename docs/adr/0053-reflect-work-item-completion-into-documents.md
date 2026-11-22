# 0053. Work Item の完了を、宿題にした Document のチェック項目と付箋へ automation の audit worker で反映する

- 状態: 提案
- 日付: 2026-11-22
- 関連: Issue #420、[ADR 0008](0008-audit-stream-two-readers-and-worker-secrets.md)、[ADR 0041](0041-document-change-signals-over-websocket.md)、[docs/documents.md](../documents.md)

## 背景

議事録のチェック項目や Whiteboard の付箋は「Work Item にする」で Work Item にでき、Document 側には
`checklist-item:<blockId>:<itemId>` / `whiteboard-note:<objectId>` の relation が残る。Work Item を
完了にしても元の項目は未完了のままで、議事録と Project 概要の「未完了の宿題」に残り続けていた。

Work Item の完了は Web・Public API・MCP・Automation のどこからでも起こる。どの経路でも反映するには、
Work Item の更新後に共通で流れるもの（audit outbox の `work-item.updated` と `completionTransition`）を
起点にする必要がある。AuditEvents stream の reader は 2 つまでに保つ（ADR 0008）。

## 決定

- 既存の automation event worker（AuditEvents stream の reader）で、`work-item.updated` かつ
  metadata の `completionTransition: true` の event を受けたら、Document の反映を行う。顧客への完了通知の
  準備と同じく、Workspace の Automation が無効でも行う。新しい stream reader や queue は作らない。
- 反映先は、その Work Item へ上の 2 種類の ID の relation を持つ要素だけにする。Document の編集者が
  明示的に「Work Item にする」で作ったつながりで、手で張った link、Work Item card、
  `system:` の relation は対象にしない。チェック項目は `checked: true` に、付箋は新しい任意 field
  `done: true` にする。文字列・relation・権限は変えない。
- 書き込みは system actor（`system:work-item-completion`）で行い、Work Item を完了にした人が
  その Document の編集権限を持つかは問わない。Document を開いて閲覧するときの権限判定は従来どおり。
  version history には system actor の編集として残る。
- Work Item の backlink row を権限で絞らずに読み（Document の table の `BACKLINK#work-item#…`）、
  Document ごとに最新 row を読んで差分を作り、`revision` の条件付き Put で本文・検索用 row・version を
  1 transaction で書く。競合したら読み直して再試行する。すでに完了済みの要素は書かない。
  同じ transaction で、event と要素ごとの operation receipt（既存の `OPERATION#` row、operation ID は
  event ID と要素 ID の hash）を残し、stream が同じ event を再配送したときは receipt のある要素を
  飛ばす。最初の試行では、その event が完了にしようとした要素の一覧（scope）も Document ごとに
  `WORK_ITEM_COMPLETION#` row に残し（変える要素がないときは Document の revision を条件に scope だけ書く）、
  再配送では scope にある要素だけを扱う。そのため最初の反映のあとに人がチェックを外しても、
  最初から完了済みだった要素を人が戻しても、再配送で戻らない。同じ Work Item を
  もう一度完了にしたときは別の event なので反映される。archive 済みの Document は変えない。
- Work Item の再オープン（`completionReopened`）ではチェックを外さない。人が自分で付けたチェックを
  消してしまうため。
- automation event worker の role には、Documents table への `dynamodb:GetItem`・`Query`・`PutItem`
  と、祖先 folder の確認に使う `ConditionCheckItem`（`TransactWriteItems` の中だけ）を足す
  （Update・Delete・Scan は付けない）。schedule job には付けない。

## 検討した選択肢

- 表示だけで反映する：editor と Project 概要で「Work Item 完了」と出し、一覧から除く。書き込みも
  IAM の追加も要らないが、チェック項目自体は未完了のまま残り、export・検索・他の画面と食い違う。
- Work Item の更新 API の中で同期的に書く：経路ごとに呼び出しが要り、Public API・MCP・Automation の
  更新で漏れる。Work Item の module が Document の table に直接依存する。
- 新しい stream reader または SQS を作る：AuditEvents stream の reader が 3 つになり throttling の
  余地が減る（ADR 0008）。queue は費用と運用対象が増える。
- 編集者が Document を開いたときに client が反映する：開かれない議事録は未完了のまま残り、
  閲覧だけの人では反映できない。

## 結果

- どの経路で完了しても、数秒〜数十秒で元のチェック項目と付箋が完了になり、Project 概要の
  「ドキュメント内の未完了の宿題」からも消える。
- worker からは WebSocket の変更通知（ADR 0041）を送らない。開いている editor は 60 秒ごとの確認か
  再読み込みで反映を受け取る。同じ checklist block を同時に編集していた人の保存は、通常の
  element 単位の競合として扱われる。
- 権限のない人が Work Item を完了にしても Document が変わる。反映先は編集者がリンクした要素に限り、
  変わるのは完了状態だけなので受け入れる。
- 1 つの Work Item に紐づく backlink は page の続きがなくなるまですべて読む。1 つの Document で
  完了にする要素が 1 回の operation 上限（4）を超えるときは、4 件ずつ Document を読み直して保存する。
- archive 済みの Document と、archive 済みの folder の下にある Document は変えない。祖先の folder の
  revision を同じ transaction で確かめ、途中で archive されたら読み直す。
- 更新した文書：`docs/documents.md`、`docs/guide/member.md`。
