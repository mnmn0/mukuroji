# 0035. 週報の未提出を、工数の督促と同じ通知 schedule と projection の fence で知らせる

- 状態: 提案
- 日付: 2026-11-21
- 関連: Issue #631、ADR 0030、ADR 0005

## 背景

#631 の残りとして、週報を出していない人に提出を促し、出さないまま週が明けたら上長にも知らせたい。
時刻は「金曜 17 時に本人、月曜に上長」を既定とし、Workspace の owner / admin が設定で変えられるようにする。

工数の督促（`timesheet.submission-reminder`）は、1 時間ごとの通知 schedule が audit outbox event を書き、
collaboration projection が配信時に元データを読み直して、まだ未提出のときだけ通知行を作る。
新しい table・queue・Lambda は増やしたくない（コストと運用）。

## 決定

- 1 時間ごとの通知 schedule に週報のパスを足す。実行時刻の日本時間（`Asia/Tokyo`）の曜日・時が
  督促の枠なら本人への督促、上長通知の枠なら上長への通知を作る。schedule は 1 時間ごとなので分は指定しない。
- 枠は Workspace の設定とし、tenant profile に `weeklyReportReminders`
  （`enabled`・`reminder`・`escalationEnabled`・`escalation`、枠は `{ weekday, hour }`）として保存する。
  変更は既存の `PATCH /api/tenant/profile`（Workspace 管理の権限と `expectedRevision` の比較）で行い、
  契約と検証（両方有効で同じ枠は拒否）は `contracts` の `readWeeklyReportReminderSettings` が持つ。
  保存していない Workspace は既定（本人 金曜 17 時、上長 月曜 10 時）。本人への督促を止めると上長通知も止まる。
  schedule は毎回 Workspace ごとに tenant profile を GetItem する。
- 対象の週は、督促の日を含む Workspace の週（週の開始曜日は tenant profile の calendar 設定）。上長への通知は、
  その時点から見て直近の督促の日を含む週について出す。
- 書く人は、Team の active な Project の unarchived な `manager` / `member` の membership を持つ人
  （Project Directory を Workspace ごとに 1 回 Query）。viewer は週報を書けないので除く。複数の Team が使う
  Project ID は、membership 行がどちらの Team のものか決められないので数えない。
- 未提出は、週の行がないか `submissionCount = 0`（ADR 0030 の週の行を BatchGet）。
- event は本人向け `weekly-report.submission-reminder`（reason `weekly-report`）と、上長 1 人ごとの
  `weekly-report.submission-escalation`（reason `weekly-report-escalation`）。重複排除 key は Workspace・Team・
  週・種類・作成者・宛先なので、同じ週の再実行は同じ event になる。event と通知行は作成者の member key と週を持つ。
  entity ID は `team/<teamId>/weekly-report/<weekStart>` で、email になりうる member key は入れない。
- projection は配信時に週の行を強整合で読み直し、提出済みなら捨てる。未提出なら「行がないか `submissionCount = 0`」の
  ConditionCheck を通知の保存と同じ transaction に入れ、間に提出されたら retry で捨てる。読み直す手段がない projection は届けない。
- 宛先は event の Project で通常どおり認可し、加えて作成者がその Project に `manager` / `member` で残っていること、
  上長通知では宛先がその Project の manager であることを、projection と Slack・Email の送信時の両方で確かめる。

## 検討した選択肢

- 別の EventBridge rule（金曜・月曜の cron）を足す: 時刻が正確だが、rule と Lambda 設定が増え、時刻変更が CDK の変更になる。
  既存の 1 時間ごとの schedule で足りる。
- schedule Lambda の環境変数にする: 実装は小さいが、時刻の変更が deploy の変更になり、Workspace ごとに変えられない。
- Team ごとの設定にする: 柔軟だが、Team 設定の画面・権限・保存が増える。今は Workspace の設定にし、要望が出たら足す。
- 上長には未提出者をまとめた 1 通にする: 通知は少ないが、配信時の再検証（全員分の読み直し）と
  一部だけ提出された場合の扱いが複雑になる。今は作成者×上長ごとにし、件数が問題になったら digest で束ねる。

## 結果

- 新しい table・queue・Lambda はない。schedule Lambda に tenant administration table の GetItem と
  Planning table の BatchGetItem、projection Lambda に Planning table の ConditionCheckItem を足す。
- schedule の枠の時刻の実行が失敗した週は、その回の通知を送らない（工数の督促と同じ）。祝日は考慮しない。
- Enterprise の role だけで Project に入っていて membership 行がない人は対象にならない。
- 週の開始曜日を変えた週は、変える前の区切りで提出した人にも督促が届くことがある。
- 時刻は日本時間に固定（Workspace の time zone は今は `Asia/Tokyo` 固定）。
- 更新した文書: `docs/notifications.md`、`docs/guide/admin.md`、`docs/guide/member.md`、`docs/guide/pm.md`。
