# 0063. Milestone の watcher を Collaboration table の `planning-entity` namespace に置き、通知の再確認は注入した reader で行う

- 状態: 提案
- 日付: 2026-11-22
- 関連: Issue #639, PR #741

## 背景

watch している Milestone の完了と日付の変更を watcher に通知する（#639）。watcher は Work Item・Project・
Planning 更新の target ではすでに Collaboration table に `entityKey` + `WATCHER#<member>` の行で持っているが、
Planning entity 単体を表す entity key はなかった。また通知は audit stream の projection、Inbox の表示、
Slack・Email の送信直前の 3 か所で、Milestone がまだ同じ scope にあり archive されていないこと、
受信者がまだ watch していることを確かめ直す必要がある。

## 決定

- Milestone の watcher は Collaboration table の entity key
  `<workspaceId>#planning-entity#<encodeURIComponent(entityId)>` に置く。行の形・自動購読の扱い・
  監査（`watcher.subscribed` / `watcher.unsubscribed`、metadata に `planningEntityId`）は既存の watcher と同じ。
  key は Collaboration module の `createPlanningEntityCollaborationEntityKey` だけが作る。
- 通知 event は Planning entity の更新 audit の event type を `planning-entity.milestone-completed` /
  `planning-entity.milestone-rescheduled` に分けて表す（`planning-entity.` の prefix は保つ）。候補は
  projection が上の key の watcher から作る。
- projection と外部チャネルの送信直前の再確認は、`PlanningMilestoneNotificationRevalidator` port を
  composition root から注入して行う。実装は Planning module の adapter-out
  （`milestone-scope-reader`、Planning table の強整合 GetItem）と Collaboration client の
  `getMemberWatcherState`（watcher 行の強整合 GetItem）を組み合わせる。port がない runtime では
  Milestone 通知を落とす（fail closed）。

## 検討した選択肢

- 選択肢 A（採用）: Collaboration table に新しい entity key namespace を足す。利点: watcher の行形式・
  購読 API・監査・Inbox の watch 判定をそのまま使える。table・index・IAM の追加がない。欠点: entity key の
  種類が 1 つ増え、key 体系の文書を更新する必要がある。
- 選択肢 B: Planning table の entity 行に watcher 一覧を持つ。利点: Milestone と同じ行で一貫して読める。
  欠点: 購読のたびに Planning の revision と競合し、watcher 数で行が膨らむ。既存の watcher の仕組みと二重になる。
- 選択肢 C: Project の watcher に Milestone の通知を送る。利点: 保存が増えない。欠点: Project の watcher は
  コメントを追う設定で、Planning の編集すべてを受け取る意図ではない。Milestone ごとに選べない。

## 結果

- Milestone ごとに watch でき、通知は watcher だけに届く。projection・Inbox・送信直前の 3 か所で
  Milestone の現在の scope と watch を確かめ直すため、archive・移動・watch 解除の後に古い通知は出ない。
- projection の Lambda は Milestone の行と watcher 行を adapter-in から直接読まず、注入された port 経由で読む。
- 文書: `docs/notifications.md`（Milestone の watch）、`docs/planning.md`、`docs/guide/pm.md`。
