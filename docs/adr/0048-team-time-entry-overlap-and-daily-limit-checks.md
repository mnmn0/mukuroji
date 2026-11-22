# 0048. 工数の時間帯の重複と1日の合計を Team ごとの設定で警告または拒否する

- 状態: 提案
- 日付: 2026-11-22
- 関連: Issue #397、ADR 0047

## 背景

#397 は、工数の時間帯の重複と1日の合計の上限を確かめ、Team ごとに警告か拒否かを選べることを求めている。
打刻の誤り（同じ時間帯を二重に記録する、終了時刻を翌日にしてしまう）は承認のときに気づかれにくく、
集計と原価を狂わせる。一方で、会議中に別の作業を記録する運用や長時間の作業を認める Team もあるので、
一律の拒否にはできない。

## 決定

- Team ごとの設定 `TeamTimeEntryPolicy { overlap, dailyLimit, dailyLimitMinutes }` を持つ。
  `overlap` と `dailyLimit` は `off`・`warn`・`reject`、`dailyLimitMinutes` は 1〜1440。保存していない Team は
  両方 `off`、上限 600 分（10 時間）。検証は `contracts` の `readTeamTimeEntryPolicy` が持つ。
- 設定は工数の analytics table に `TIME_POLICY#<teamId>` の行として保存する。`revision` で楽観的排他を取り、
  保存は監査 event `time-entry-policy.updated`（変更前後の設定）と idempotency の receipt を同じ transaction に入れる。
  古い `expectedRevision` は `409 TimeEntryPolicyRevisionConflict`。
- API は `GET /api/teams/:teamId/time-entry-policy`（Team の viewer 以上、`{ policy, canEdit }`）と
  `PUT /api/teams/:teamId/time-entry-policy`。設定は Team のすべての Project に効くので、変更できるのは月の締めと同じく
  Team 全体の管理者だけとし、ほかは `403 TimeEntryPolicyDenied`。
- 確かめるのは工数の作成と更新（`POST` / `PATCH /api/teams/:teamId/time-entries`）。更新では `startAt`・`endAt` が
  変わるときだけ確かめるので、上限を下げた後も既存の記録のメモや区分は直せる。
  比べる相手は同じ Team の同じメンバーの記録（下書きから承認済みまで全部）で、日付は Workspace のタイムゾーン
  （いまは `Asia/Tokyo`）の暦日で数える。日をまたぐ記録はそれぞれの日に分けて足す。
- 日付と時間数だけの記録（`durationOnly`、間接作業など）は時刻に意味がないので重複の対象にしないが、1日の合計には入る。
- `reject` は `409 TimeEntryOverlap` / `409 TimeEntryDailyLimitExceeded` で保存しない。`warn` は保存したうえで
  応答に `warnings`（`TimeEntryOverlap { entryIds }`、`TimeEntryDailyLimitExceeded { date, minutes, limitMinutes }`）を付ける。
  警告がないときは `warnings` を付けないので、既存の client はそのまま動く。
  警告は記録の持ち主が自分の記録を保存したときだけ返す。管理者がほかのメンバーの記録を直したときは返さない
  （警告は持ち主の Team 全体の記録と比べるので、一部の Project の管理者には見えない記録の ID や合計が混じる）。
- タイマーの停止で作る記録は確かめない。実際に計った時間なので、拒否すると記録が失われる。

## 検討した選択肢

- Workspace で1つの設定にする: 管理は楽だが、#397 が Team ごとの選択を求めている。Team の運用の差（会議中の並行作業など）も大きい。
- 重複と上限を transaction の条件で厳密に守る: メンバーと日ごとの集計行を持ち、記録の保存と同じ transaction で
  更新する必要があり、日をまたぐ記録や区分の変更でも集計行を直す。誤入力を防ぐ目的には、日付 index を読む
  確認で足りる。同時に保存した2件が両方とも通ることはある。
- 承認のときにだけ確かめる: 誤りに気づくのが遅れ、本人が直す前に提出されてしまう。
- 提出済みの記録を相手から外す: 二重記録は提出済みの記録との間でも起きるので、状態にかかわらず比べる。

## 結果

- 新しい table・index・queue はない。工数の作成と時刻を変える更新で、設定の GetItem 1回と、チェックが有効なら
  日付 index の Query 1回が増える。
- 日付 index は結果整合なので、ほぼ同時に保存した記録どうしの重複は見逃すことがある。
- Workspace のタイムゾーン設定を持つようになったら、日付の区切りはそれに従う。
- 更新した文書: `docs/time-tracking.md`、`docs/guide/pm.md`、`docs/guide/member.md`。
