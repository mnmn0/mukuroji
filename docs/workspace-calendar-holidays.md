# Workspace の稼働カレンダーと日本の祝日

Workspace の稼働カレンダーは、稼働曜日・会社の休日・日本の祝日を使うかどうかで決まる（`WorkspaceCalendarSettings`）。
新しい Work Item はこの稼働カレンダーから作った calendar policy（`createWorkspaceWorkItemCalendarPolicy`）を
`schedule.calendarPolicy` に写して保存し、稼働日数はその policy で数える。保存済みの Work Item の日程は、
Workspace の設定を保存しただけでは変わらない（下の「Team・Project のカレンダーと変更の適用」で揃える）。

## Team・Project のカレンダーと変更の適用

Team と Project は Workspace の稼働カレンダーへの上書きを持てる（[ADR 0058](adr/0058-team-project-shared-work-calendars.md)）。

- 上書きできるのは稼働曜日、日本の祝日を使うかどうか、足す会社の休日（最大 128 日）。省いた項目は継承する。
  解決順は Workspace → Team → Project で、稼働曜日と祝日の有無は後の層が勝ち、会社の休日は足し合わせる。
- 行は tenant administration table の Workspace partition に置く（Team は `WORK_CALENDAR#TEAM#<teamId>#`、
  Project は `WORK_CALENDAR#TEAM#<teamId>#PROJECT#<projectId>`）。`revision` の条件付きで保存し、古い revision は 409。
- Work Item の policy の `calendarSource: 'shared'` は「共有カレンダーの写し」を表し、カレンダーの変更で書き換えてよい。
  ない policy は個別の上書きで、カレンダーを変えても変わらない。既存の row は `calendarSource` を持たないので移行は要らない。
- 新しい Work Item は、policy が `shared` なら server が作成先の Team・Project のカレンダーで写し直す（開始日と終了日を保ち、稼働日数を数え直す）。

| API | 権限 | 内容 |
| --- | --- | --- |
| `GET /api/teams/:teamId/work-calendar[?projectId=]` | Team（と Project）の viewer | 保存済みの上書き、解決済みの policy、変更できるか |
| `POST /api/teams/:teamId/work-calendar/preview` | Team 設定の管理者、Project は Project manager も | 保存せずに影響を返す |
| `PUT /api/teams/:teamId/work-calendar` | 同上 | 保存し、従う Work Item を書き換える |
| `POST /api/workspace/work-calendar/preview` | Workspace 管理者 | 候補の Workspace 設定の影響を返す |
| `POST /api/workspace/work-calendar/apply` | Workspace 管理者 | 保存済みの Workspace 設定に `shared` な Work Item を揃える |

- 調整は `keep-duration`（開始日と稼働日数を保ち、終了日を動かす）と `keep-end-date`（開始日と終了日を保ち、稼働日数を数え直す。
  0 日になるものは `keep-duration`）から選ぶ。選んだ調整はカレンダーの行に保存する。
  次の既定にするのは Team の行の調整だけで、Project の画面も Team の行の調整を最初に選ぶ。
- 従う Work Item は `shared` のものと、Team・Project の変更では変更前の解決済み policy と同じ規則を持つ旧来の Work Item。
  旧来の Work Item は書き換えるときに `shared` にする。書き換えるのは新しいカレンダーと規則が違う Work Item だけ。
  Workspace の apply は旧来の Work Item を取り込まない。
- 書き換えは schedule cascade の書き込み（24 件ずつ、Work Item の revision で fence、audit は `schedule-cascade-updated`）を使う。
  1回に書き換えるのは 480 件まで、1 Team の Work Item が 1000 件を超えるときも 413。衝突した transaction は読み直して1件ずつ再試行し、それでも衝突した Work Item は件数だけ返す。
- Project のカレンダーの変更は、その Project に割り当てられた Work Item だけを書き換える。
- 書き換えの途中で同じ範囲のカレンダーが保存し直されたら、残りは新しい変更に任せて衝突として数える。
- 書き換えは日程 dependency を伝播させない。制約を満たさなくなった Work Item は Planning の constraint conflict として表示される。
- preview の例は開始日順に最大 10 件で、読む人が見られる Work Item だけを出す。

## 休日の決まり方

- 会社の休日: 管理者が日付で入れる（最大 512 日）。
- 日本の祝日: `publicHolidays: 'japan'` のとき、内閣府から取り込んだ祝日（取り込み前は同梱の祝日）も休日になる。`'none'` なら会社の休日だけ。
  この設定がない保存済みの Workspace と、まだ設定を保存していない Workspace は `'japan'` として扱う。
- Work Item の policy には両方を重ねた日付を入れる（`listWorkspaceDaysOff`）。policy の休日は最大 512 件なので、
  超えるときは、今年と来年（日本時間）の祝日を必ず残し、残りの枠に今日に近い日付から入れる（同じ近さなら後の日付）。
  外れるのは今日から遠い会社の休日や過去の祝日。

## 稼働カレンダーを既定で使う作成経路

| 経路 | calendar policy |
| --- | --- |
| Web の task 画面、Team の Issue 画面 | 選んだ Team・Project のカレンダー（読み込み前は Workspace の稼働カレンダー、それも読めなければ月〜金・休日なし）。server が作成先のカレンダーで写し直す |
| Public API `POST /api/v1/work-items` | `schedule` を省いたとき server が Workspace の稼働カレンダーを付ける（`dueDate` があれば期限付き、なければ未スケジュール）。`schedule` を送ったときはその policy のまま |
| MCP `create_task` | `schedule` を省いて Public API に送るので、Public API と同じ |
| Project template の WBS 適用 | 対象 Team のカレンダーで開始日からの稼働日を数え、その policy を各 Work Item に付ける。適用の受付時に稼働カレンダーを固定し、再試行でも同じものを使う |
| 依頼フォーム・Triage からの作成 | 作成先の Team・Project のカレンダー |
| Automation の作成 action | 作成先の Team のカレンダー |
| CSV / JSON import | 行の `schedule` に `calendarPolicy` がないとき Workspace の稼働カレンダー。日付範囲で `durationDays` もないときは、その policy で数える。commit した job は作成時の稼働カレンダーを保存し、worker の再試行でも同じものを使う |

上の表の「Workspace の稼働カレンダー」は、作成先の Team・Project にカレンダーがあればそれで上書きしたもの（Public API・MCP・import は Team まで）。

期限・期限超過の判定は policy の time zone で今日の日付を決めて期限日と比べるだけで、休日を使わない。
期限日は policy の休日を避けて置かれ、policy は Team・Project のカレンダーの写しなので、critical path と同じカレンダーで判定される。
Work Item の critical path は日付範囲の稼働日数（`durationDays`）で数える。Planning entity の critical path は
forecast（無ければ baseline）の日付範囲を Workspace の稼働カレンダーで数えた稼働日数（最小 1）で数える。
lag は稼働日の差として足す（日程 dependency の伝播は従来どおり暦日の lag で動かす）。

## 祝日データの出典と更新

祝日は内閣府が公開する「国民の祝日」の CSV（<https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv>、
出典: 内閣府「国民の祝日」について）を、アプリの更新なしに月に1回取り込む（[ADR 0032](adr/0032-japanese-public-holiday-monthly-sync.md)）。

- scheduled-jobs Lambda の `japanese-public-holiday-sync` job が 6 時間ごとに起動し、今月（日本時間）の一覧が
  まだ保存されていなければ CSV を取得する。月初の最初の起動で取り込み、失敗したら次の起動でまた試す。
- CSV は全行を読めた場合だけ使う。2020 年以降を残し、各年に 15〜25 日の休日があり、今年まで載っていることを確かめる。
  保存済みの一覧より前の年で終わる一覧も、来年の祝日を失わないよう保存しない。
  満たさない一覧は保存せず、前回の一覧のまま動く（job は失敗して scheduled-jobs DLQ に残る）。
  保存済みの row が壊れているときは、次に取り込めた一覧で置き換える。
- 一覧は tenant administration table の `workspaceId = system#public-holidays`、`recordKey = JAPAN` の row に置く。
- API は保存済みの一覧を 1 時間 process 内に保持し、新しい Work Item の policy と
  `GET /api/workspace/calendar-settings` の `nationalHolidayDates` に使う。Web はその日付で policy を作り、Gantt を網掛けする。
- 保存済みの一覧に来年がまだ載っていないとき（翌年の春分・秋分は国立天文台が例年 2 月に公表するので、それまでの CSV は来年を含まないことがある）は、同梱の祝日のうち
  保存済みの一覧より後の年を足す。保存済みの row も取り込み時と同じ年ごとの検査を通らなければ使わない。
- 一度も取り込んでいないとき、または保存済みの一覧を読めないときは、前に読んだ一覧か同梱の祝日を使う。
  祝日の取得・読み取りの失敗で Work Item の作成は止まらない。
- 振替休日と国民の休日は、CSV と同じく名前を `休日` とする。

取り込みを試すときは `JAPANESE_PUBLIC_HOLIDAYS_SOURCE_URL` で CSV の URL を差し替えられる（loopback の HTTP も可）。

### 同梱の祝日（フォールバック）

`contracts/src/japanese-public-holidays.ts` の `JAPANESE_PUBLIC_HOLIDAYS_BY_YEAR` に、取り込み前に使う祝日を年ごとに持つ。

- 祝日・振替休日・国民の休日は「国民の祝日に関する法律」（昭和23年法律第178号）の規定から決まる事実で、
  法令は著作権の対象ではない（著作権法第13条）。
- 春分の日と秋分の日は、国立天文台が毎年2月に翌年分を公表する暦要項の日付に合わせる。
- 第三者が配布する祝日データ（ファイルや API）は写していない。そのためデータの利用条件は本リポジトリの
  Apache-2.0 と衝突しない。内閣府の CSV はリポジトリに含めず、各環境が実行時に取得する。

月1回の取り込みがあるので、同梱の祝日を毎年足す必要はない。足すときは次の手順に従う。

1. 国立天文台の暦要項（翌年）の「国民の祝日」を開き、日付と名前を確認する。表の下に「◯月◯日は休日になる。」と
   書かれた日（振替休日・国民の休日）は名前を `休日` にして入れる。
2. `JAPANESE_PUBLIC_HOLIDAYS_BY_YEAR` に翌年の配列を日付順で足す。
3. `bun test contracts/test/japanese-public-holidays.test.ts` を実行する。テストは祝日法の規則と春分・秋分の近似式から
   各年の休日を別に計算して照合する。祝日法が改正されたときや、暦要項の春分・秋分が近似式と違うときはテストが落ちるので、
   法改正や暦要項に合わせてテストの規則も直す。

保存済みの Work Item の policy には、作成時に使っていた祝日しか入っていない。取り込みで祝日が増えても、既存の
Work Item の policy は変わらない。
