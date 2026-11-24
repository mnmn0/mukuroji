# 0064. Analytics の定期配信を受信者ごとの索引行で持ち、「自分への配信」を 1 回の Query で読む

- 状態: 提案
- 日付: 2026-11-22
- 関連: Issue #401、[ADR 0021](0021-analytics-delivery-notification-outbox.md)、
  [docs/analytics.md](../analytics.md)

## 背景

#401 は「自分に配信された report」の一覧を求めている。定期配信は受信者ごとに snapshot と delivery receipt を
保存し（ADR 0021）、Inbox に通知する。receipt の record key は
`DELIVERY#<reportId>#<sha256(occurrenceKey)>` で、occurrence key は配信時刻・配信時の report 定義 hash・
受信者 hash から作る。そのため受信者からは引けず、report を後から編集すると定義 hash が変わるので、過去の
配信を report から組み立て直すこともできない。

Inbox の通知は受信者ごとに残るが、既読や archive で一覧から消え、通知設定で Inbox を切った受信者には残らない。
配信の一覧の正本には使えない。

制約は次のとおり。

- 新しい table や GSI を足さない（常時課金の resource を増やさない）。
- 受信者本人の配信だけを読み、他のメンバーの配信を cursor などで辿れないようにする。
- 一覧に出すかどうかは、今その report を読めるかで決める。snapshot を開くときは今の permission scope の確認を
  そのまま通す。

## 決定

- Analytics table の Workspace partition に、受信者ごとの索引行を足す。record key は
  `DELIVERY_RECIPIENT#<sha256(memberKey) の先頭 32 桁>#<deliveredAt>#<reportId>#<snapshotId>` で、`entryType` は
  `analytics-delivery-recipient`。行は report ID・snapshot ID・形式・配信時刻・受信者 member key を持つ。
  member key は key に入れず hash にする。
- 定期配信は receipt を確定した後、通知の直前に索引行を条件なしの Put で書く。同じ配信の再試行でも同じ内容に
  なるので、通知に失敗した再試行でも行は 1 つだけ残る。report の編集で同じ回をもう一度配信したときは snapshot ID が
  変わるので、行は別になり、先の配信も残る。
- Enterprise の route 権限は、ほかの Analytics の読み取りと同じ `work-items.read` にする。
- `GET /api/analytics/deliveries?limit&cursor` は caller 本人の prefix を `begins_with` と
  `ScanIndexForward: false` で新しい順に Query する（1 page 最大 50 件、既定 20 件）。cursor は Workspace と
  受信者 prefix に結び付け、境界の record key が本人の prefix の中にあることも確かめる。
- 各行は今その report を読めるとき（report 一覧と同じ `canReadAnalyticsReport`）だけ返し、report 名は今の
  名前にする。読めない行や削除された report の行は飛ばすので、page は limit より短くなることがある。
- Web の Reports 画面は最初の page を「自分への配信」の選択肢に出し、選ぶと report と snapshot を開く。
  snapshot を開くときは既存の permission scope hash の確認を通す。

## 検討した選択肢

- 受信者を key にした GSI を足す: 書き込みは今のままで済むが、index の分だけ常時の書き込みと storage が増え、
  既存の receipt 行（受信者を配列で持つ）を射影し直す必要がある。
- Inbox の通知から一覧を作る: 新しい行は要らないが、既読・archive・通知設定で消えるので配信の記録にならない。
- 読める report の schedule と next run から直近の receipt を引き直す: 定義 hash が配信時のものなので、編集後は
  引けない。最新の 1 回しか出せない。
- 受信者ごとの索引行（採用）: 同じ table・同じ partition で 1 回の Query で読め、書き込みは配信 1 件に 1 回増える
  だけで済む。

## 結果

- 受信者は配信の履歴を新しい順に辿れる。report を読めなくなった配信は一覧から消え、snapshot も開けない。
- 配信 1 件ごとに Analytics table への Put が 1 回増える。行は snapshot と同じく消さない（snapshot の保持期間を
  決めるときに一緒に見直す）。
- この変更の前に行った配信の索引行はない。初回 deploy 前なので backfill は不要。
- 更新した文書: [docs/analytics.md](../analytics.md)、[docs/guide/pm.md](../guide/pm.md)。
