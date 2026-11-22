# 0058. Team・Project の稼働カレンダーを tenant administration table の Workspace partition に置き、Work Item は共有カレンダーの写しを持って変更時に書き換える

- 状態: 提案
- 日付: 2026-11-22
- 関連: Issue #337, #365, ADR 0032, ADR 0013

## 背景

Workspace の稼働カレンダー（稼働曜日・会社の休日・日本の祝日）は Workspace に1つしかなく、
新しい Work Item は作成時の policy を `schedule.calendarPolicy` に写して保存する。保存後は Workspace の設定を変えても
日程は変わらない。Team や Project ごとに休みが違う組織では、Work Item ごとに policy を作り直すしかなかった。

あわせて次を決める必要があった。

- Team・Project の既定カレンダーを Work Item がどう継承するか。
- カレンダーを変えたとき、それに従う Work Item の日程をどう動かすか（期間を保つか、終了日を保つか）。
- Planning の critical path を同じ稼働カレンダーで数えること。
- #365 の data migration 契約（変換は row だけを見る純関数）に合わせ、保存済みの Work Item を移行なしに読めること。

## 決定

### 保存

- Team・Project のカレンダーは tenant administration table の Workspace partition に1カレンダー1行で置く。
  - Team: `recordKey = WORK_CALENDAR#TEAM#<teamId>#`
  - Project: `recordKey = WORK_CALENDAR#TEAM#<teamId>#PROJECT#<projectId>`
  - `entryType = work-calendar`。Team の行と、その Team の Project の行は `WORK_CALENDAR#TEAM#<teamId>#` の begins_with で1回の Query で読める。
- 行は Workspace の設定への上書きだけを持つ（`workingWeekdays?`、`publicHolidays?`、`additionalHolidays`、最大 128 日）。
  省いた項目は継承する。解決順は Workspace → Team → Project で、稼働曜日と日本の祝日の有無は後の層が勝ち、会社の休日は足し合わせる。
- 行は `revision` を持ち、保存は `expectedRevision` の条件付き Put にする（0 なら行がないこと）。古い revision は 409。
- Workspace partition に置くので、tenant export と Workspace の closure で一緒に扱われる。新しい table・GSI は作らない。

### Work Item の policy

- `WorkItemScheduleCalendarPolicy` に任意の `calendarSource: 'shared'` を足す。`shared` の policy は
  「共有カレンダーの写し」で、Team・Project・Workspace のカレンダーが変わったときに書き換えてよい。
  ない policy は個別の上書き（custom）で、カレンダーの変更では変えない。
- 既存の row は `calendarSource` を持たないので custom として読める。#365 の migration は不要。
- 写しを持ち続けるのは、日程の稼働日数を読むたびにカレンダーを解決しないため（一覧・Gantt・Analytics・Public API の読み取りを変えない）。
- 新しい Work Item は、作成経路（Web、Public API、MCP、依頼フォーム・Triage、Automation、Project template、import）で
  policy が `shared` なら、server が作成先の Team・Project のカレンダーを解決し直し、終了日を保つ調整で写す。
  利用者が自分で決めた policy（`shared` でない）はそのまま保存する。
  Project template の WBS は、適用の受付時に対象 Team のカレンダーを固定し、その上で稼働日の offset と日数を数える（作成時に写し直さない）。

### 変更の preview と適用

- `GET /api/teams/:teamId/work-calendar[?projectId=]` で保存済みの上書きと解決済みの policy を返す。
- `POST /api/teams/:teamId/work-calendar/preview` で、変更が Work Item をどう動かすかを保存せずに返す。
  `PUT /api/teams/:teamId/work-calendar` で保存し、従う Work Item を書き換える。
- Workspace のカレンダーは既存の設定画面で保存し、そのあと `POST /api/workspace/work-calendar/preview` / `apply` で
  Workspace 全体の `shared` な Work Item を新しいカレンダーに揃える。
- 調整は「期間を保つ」（`keep-duration`: 開始日と稼働日数を保ち、終了日を動かす）と
  「終了日を保つ」（`keep-end-date`: 開始日と終了日を保ち、稼働日数を数え直す。0 日になるものは期間を保つ）から選ぶ。
  選んだ調整はカレンダーの行に保存し、次の画面の既定にする。
- 従う Work Item は `calendarSource: 'shared'` のものと、Team・Project の変更では変更前の解決済み policy と同じ規則を持つ旧来の Work Item。
  後者は書き換えるときに `shared` にする（旧来の Workspace 既定から作った Work Item を取り込む）。
  書き換えるのは新しいカレンダーと規則が違う Work Item だけで、印を付けるためだけには書き換えない
  （既存の Work Item が多い Team で、最初の変更が件数の上限に当たらないようにする）。
- 書き換えは既存の schedule cascade の書き込み（24 件ずつの transaction、Work Item の revision による fence、
  audit の `schedule-cascade-updated`）を使う。1回の変更で書き換えるのは 480 件まで、超えると 413。
  他の更新と衝突した transaction は、読み直した Work Item で同じ変更前・変更後のカレンダーから1件ずつ計画し直して再試行する
  （取り込み中の旧来の Work Item も対象から外れない）。それでも衝突した Work Item は数だけ返す。
- Project のカレンダーの変更が書き換えるのは、その Project に割り当てられた Work Item だけ（Project manager が他の Project の日程を変えない）。
- 計画と書き換えの手順は work-items module の use case（`application/use-cases/work-calendar-change.ts`）が持ち、
  route は入力の検証・認可・port の接続だけを行う。
- 日本の祝日の同期済みの一覧は、Workspace が祝日を使わない設定でも読む（Team・Project が祝日を使う上書きを持てるため）。
- preview の例は最大 10 件で、読む人が見られる Work Item だけを出す。

### 権限

- 読み取り: Team の viewer（Project は Project の viewer も）。Enterprise では `teams.read`。
- Team のカレンダーの変更: Team 設定を管理できる人（`requireTeamConfigurationAdministration`）。
- Project のカレンダーの変更: Team 設定を管理できる人か、その Project の manager。Enterprise では `teams.manage`。
- Workspace の preview・apply: Workspace 管理者（Enterprise では `workspace.manage`）。

### Critical path と期限

- Work Item の critical path は、日付範囲の Work Item を policy の稼働日数（`durationDays`）で数える。
- Planning entity の critical path は、forecast（無ければ baseline）の日付範囲を Workspace の稼働カレンダーで数えた稼働日数（最小 1）で数える。
- 期限・期限超過は policy の time zone で今日を決めて期限日と比べる。期限日は policy の休日を避けて置かれているので、休日は使わない。
  Team・Project のカレンダーが policy に写るので、期限と critical path は同じカレンダーで判定される。

## 検討した選択肢

- 選択肢 A（採用）: 共有カレンダーの写し＋`calendarSource` の印。読み取りは変わらず、migration も要らない。
  欠点はカレンダーの変更時に書き換えが要ることと、書き換えが終わるまで古い写しが残ること。
- 選択肢 B: Work Item はカレンダーへの参照だけを持ち、読むたびに解決する。常に最新になるが、日程を読むすべての経路
  （一覧、Gantt、Analytics の history、Public API、MCP）でカレンダーの読み取りが増え、カレンダーを変えると保存済みの終了日が黙って動く。
  「期間を保つ / 終了日を保つ」を選べない。
- 選択肢 C: Team・Project のカレンダーを project directory table の Team row に持つ。Team の読み取りと同時に読めるが、
  Team row の schema と directory の書き込み経路を変える必要があり、tenant administration の export・closure とも分かれる。

## 結果

- Team・Project ごとの休みを Work Item に継承でき、変更時に影響を確かめてから日程を揃えられる。
- 受け入れる欠点:
  - Team・Project をまたいで移動した Work Item は、次にそのカレンダーを適用するまで移動前の写しのまま。
  - Workspace の apply は旧来（`calendarSource` なし）の Work Item を取り込まない。Team・Project の変更でだけ取り込む。
  - 日程 dependency の伝播は従来どおり暦日の lag で動かす。critical path は lag を稼働日の差として足す。
  - import job は作成先 Team のカレンダーを使い、行ごとの Project のカレンダーは使わない。
  - 1 Team の Work Item は 1000 件（`WORK_ITEM_HIERARCHY_MAX_ITEMS`）まで読む。超える Team のカレンダー変更は 413 で断る。
- 見直す条件: 1回の変更で 480 件を超える Team が増えたら、書き換えを非同期 job にする。
- 更新した文書: `docs/workspace-calendar-holidays.md`、`docs/planning.md`、`docs/guide/admin.md`、`docs/guide/pm.md`。
