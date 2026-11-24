# 0084. Project charter の責任者変更を、charter 保存後の書き込みで Project の進捗報告の担当者へ移す

- 状態: 提案
- 日付: 2026-11-24
- 関連: Issue #638, Issue #340, PR #472, ADR 0012

## 背景

Project の charter（Project Directory table）は責任者（PM）を持ち、Planning（Planning table）の
`UPDATE_TARGET#PROJECT#<teamId>#<projectId>` は、同じ Project の進捗報告（health update）の担当者を
cadence の `updateOwnerMemberKey` として持つ。どちらも同じ「この Project の報告に責任を持つ人」を表すが、
別々に設定するため、charter の責任者を変えても進捗報告の督促は前の責任者に届き続けていた。
Issue #638 は「charter の責任者を変えると health update の owner も変わる」ことを求めている。

2つの値は別 table にあり、Planning の書き込みは Workspace 単位の revision（ADR 0012）と、
更新担当者の権限を commit 時に確かめる condition check を伴う。

## 決定

- charter の PUT が責任者を変えたとき（保存前の責任者と member key が違うとき）だけ、charter の保存に
  続けて Planning の Project update target の cadence を、担当者だけを新しい責任者にして書き直す。
  責任者を外したとき、責任者以外の項目だけを保存したときは cadence に触れない。
- この書き込みは cadence endpoint と同じ確認を通す。呼び出した人が Project の update target の manager で
  あること、新しい責任者がその Project の member 以上で publish できること、既存の escalation 先が viewer 以上で
  あること。Enterprise 管理の人は charter の route が `projects.manage` で認可されているので、その Project での `planning.write` を別に評価し、なければ `not-permitted` にする。commit 時の fence も cadence endpoint と同じものを付ける（service account には membership 行がないので、その fence だけ除く）。
- cadence の transaction には、charter の責任者がまだこの人であるという条件も付ける。連続した2回の保存が
  重なり、先の保存の書き換えが後から終わっても、後の保存の責任者を上書きしない。条件が外れたときは
  `superseded` を返す。
- charter の保存と cadence の書き換えは1つの transaction にしない。charter は先に確定し、cadence の結果は
  charter の応答の `updateOwnerSync`（`synced`、`unchanged`、`not-configured`、`not-permitted`、
  `owner-not-eligible`、`superseded`、`failed`）で返す。Web は `synced` 以外の失敗を保存後のメッセージで示す。
- Planning の revision が読み取りと書き込みの間に進んだときは、読み直して3回まで試す。
- 逆向き（Planning で担当者を変えたとき charter の責任者を変える）は行わない。進捗報告だけを
  別の人に任せる運用を残すため。

## 検討した選択肢

- 選択肢 A: charter と cadence を1つの DynamoDB transaction で書く。利点: 片方だけ変わることがない。
  欠点: Planning の mutation は revision の CAS、due index、receipt を自分の transaction で組み立てるため、
  directory の書き込みを入れるには Planning adapter の境界を広げる必要がある。担当者になれない責任者を
  選んだときに charter の保存まで失敗する。
- 選択肢 B: 読み取り時に charter の責任者を cadence の担当者として扱う。利点: 書き込みが増えない。
  欠点: 通知 schedule worker、Update Feed、Inbox が cadence の担当者を直接読んでおり、すべての読み手を
  変える必要がある。
- 選択肢 C（採用）: charter 保存後に cadence endpoint と同じ確認で cadence を書き直し、結果を応答で返す。
  利点: 既存の Planning の不変条件と権限確認をそのまま使える。欠点: 2回目の書き込みが失敗すると
  一時的に値がずれる。その場合は `failed` を返し、利用者が Planning で直す。

## 結果

- charter の責任者を変えると、権限が足りる限り進捗報告の担当者も同じ人になる。
- ずれが残るのは、担当者になれない責任者を選んだとき、更新スケジュールを変えられない人が保存したとき、
  2回目の書き込みが失敗したときで、どれも保存後のメッセージで分かる。
- `docs/planning.md` と利用者ガイド（`docs/guide/pm.md`）に同期の規則を書いた。
