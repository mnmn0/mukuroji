# 0011. Analytics の定期配信を audit outbox 経由で受信者に通知する

- 状態: 提案
- 日付: 2026-11-19
- 関連: Issue #401、ADR 0005、ADR 0008

## 背景

Analytics の定期配信は recipient ごとに immutable snapshot と receipt を保存するだけで、受信者には
何も知らされなかった。受信者の Inbox（設定により Slack / Email）へ snapshot への link を届けたい。
一方で、配信は 5 分ごとの scheduled-jobs Lambda が行い、receipt を完了 checkpoint とする retry
設計になっている。通知は重複させず、権限を失った受信者には届けてはいけない。

Inbox 行・Slack / Email の queue・受信者の membership と Team access の再確認は、すでに AuditEvents
stream を読む collaboration projection が持っている。ADR 0008 で AuditEvents stream の reader は
2 つに保つと決めている。

## 決定

- Analytics schedule は snapshot を保存した後、receipt を保存する前に、recipient ごとに 1 件の
  `analytics.report.delivered` audit event を AuditEvents へ条件付き put する。Event ID は receipt の
  occurrence key から決め、retry では `ConditionalCheckFailedException` を配信済みとして扱う。
- Event は `metadata.notificationCandidates` にその recipient だけを持ち、report 名を title、
  `/reports?v=1&report=<id>&snapshot=<id>` を deep link にする。Team visibility の report は Team ID を
  載せ、projection と外部送信の直前の認可で Team access を再確認させる。
- Inbox の表示時は report を読み直し、現在の visibility（personal / team / shared）を満たさない
  通知を隠す。Link 先の snapshot は従来どおり現在の permission scope で絞る。
- scheduled-jobs Lambda には AuditEvents table への `dynamodb:PutItem` と `AUDIT_RETENTION_DAYS` を
  足す。AuditEvents stream の reader は増やさない。

## 検討した選択肢

- 選択肢 A: audit outbox に event を書き、既存の collaboration projection に通知させる（採用）。
  Inbox・Slack・Email・digest・quiet hours・認可の再確認をそのまま使える。Analytics から通知 table
  への直接書き込みや stream reader の追加が要らない。欠点は、audit log に配信 event が残ること。
- 選択肢 B: Analytics Lambda が NotificationsTable へ直接書く。Projection が持つ preference・
  delivery queue・認可の処理を二重に持つことになり、channel 追加のたびに追従が要る。
- 選択肢 C: Analytics 専用の queue と worker を足す。Slack / Email の送信と認可をもう一度作ることになり、
  コストと運用対象が増える。

## 結果

- 定期配信の受信者に Inbox 通知が届き、Slack / Email を選んだ受信者にはそちらにも届く。
- Shared report の Slack / Email は Workspace guest に送らない（projection の外部送信の既定どおり）。
- 配信後に report の visibility が変わった場合、Inbox は表示時に隠すが、既に queue に載った
  Slack / Email は event に載せた Team ID だけで再確認する。Report 自体の再読込みが必要になったら、
  projection に Analytics table の読み取りを足すかを見直す。
- 更新した文書: `docs/analytics.md`（Scheduled delivery）、`docs/guide/pm.md`。
