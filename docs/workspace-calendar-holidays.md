# Workspace の稼働カレンダーと日本の祝日

Workspace の稼働カレンダーは、稼働曜日・会社の休日・日本の祝日を使うかどうかで決まる（`WorkspaceCalendarSettings`）。
新しい Work Item はこの稼働カレンダーから作った calendar policy（`createWorkspaceWorkItemCalendarPolicy`）を
`schedule.calendarPolicy` に写して保存し、稼働日数はその policy で数える。保存済みの Work Item の日程は、
Workspace の設定を変えても変わらない。

## 休日の決まり方

- 会社の休日: 管理者が日付で入れる（最大 512 日）。
- 日本の祝日: `publicHolidays: 'japan'` のとき、アプリに同梱した祝日も休日になる。`'none'` なら会社の休日だけ。
  この設定がない保存済みの Workspace と、まだ設定を保存していない Workspace は `'japan'` として扱う。
- Work Item の policy には両方を重ねた日付を入れる（`listWorkspaceDaysOff`）。policy の休日は最大 512 件なので、
  超えるときは古い日付から外す。

## 稼働カレンダーを既定で使う作成経路

| 経路 | calendar policy |
| --- | --- |
| Web の task 画面、Team の Issue 画面 | 読み込んだ Workspace の稼働カレンダー（読み込み前・失敗時は月〜金・休日なし） |
| Public API `POST /api/v1/work-items` | `schedule` を省いたとき server が Workspace の稼働カレンダーを付ける（`dueDate` があれば期限付き、なければ未スケジュール）。`schedule` を送ったときはその policy のまま |
| MCP `create_task` | `schedule` を省いて Public API に送るので、Public API と同じ |
| Project template の WBS 適用 | Workspace の稼働カレンダーで開始日からの稼働日を数え、その policy を各 Work Item に付ける |
| 依頼フォーム・Triage からの作成 | Workspace の稼働カレンダー |
| CSV / JSON import | 行の `schedule` に `calendarPolicy` がないとき Workspace の稼働カレンダー。日付範囲で `durationDays` もないときは、その policy で数える。commit した job は作成時の稼働カレンダーを保存し、worker の再試行でも同じものを使う |

期限・期限超過の判定は policy の time zone で今日の日付を決めて期限日と比べるだけで、休日を使わない。
Planning の critical path（Planning entity と Work Item の依存関係）は、日付範囲の暦日数と暦日の lag で数える。
Work Item の稼働日数は policy の休日を除いて数え、日付範囲の始点と終点はすでに休日を避けて置かれているので、
critical path は休日を数え直さない。

## 祝日データの出典

`contracts/src/japanese-public-holidays.ts` の `JAPANESE_PUBLIC_HOLIDAYS_BY_YEAR` に年ごとに持つ。

- 祝日・振替休日・国民の休日は「国民の祝日に関する法律」（昭和23年法律第178号）の規定から決まる事実で、
  法令は著作権の対象ではない（著作権法第13条）。
- 春分の日と秋分の日は、国立天文台が毎年2月に翌年分を公表する暦要項の日付に合わせる。
- 第三者が配布する祝日データ（ファイルや API）は写していない。そのためデータの利用条件は本リポジトリの
  Apache-2.0 と衝突しない。
- 振替休日と国民の休日の名前は法律の呼び方に合わせて `休日` とする。

## 翌年分の追加手順

毎年2月の暦要項の公表後に、翌年分を足す。

1. 国立天文台の暦要項（翌年）の「国民の祝日」を開き、日付と名前を確認する。表の下に「◯月◯日は休日になる。」と
   書かれた日（振替休日・国民の休日）は名前を `休日` にして入れる。
2. `JAPANESE_PUBLIC_HOLIDAYS_BY_YEAR` に翌年の配列を日付順で足す。
3. `bun test contracts/test/japanese-public-holidays.test.ts` を実行する。テストは祝日法の規則と春分・秋分の近似式から
   各年の休日を別に計算して照合する。祝日法が改正されたときや、暦要項の春分・秋分が近似式と違うときはテストが落ちるので、
   法改正や暦要項に合わせてテストの規則も直す。
4. 古い年は消さない（過去の Gantt の網掛けに使う）。policy の休日が 512 件を超える場合は古い日付から外れる。

保存済みの Work Item の policy には、作成時に同梱されていた年の祝日しか入っていない。翌年分を足しても既存の
Work Item の policy は変わらない。翌年分を足すのが遅れると、その間に作った翌年にまたがる Work Item は翌年の祝日を
稼働日として数えるため、2月の公表後は早めに足す。
