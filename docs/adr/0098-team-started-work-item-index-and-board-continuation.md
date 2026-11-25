# 0098. Team の started な Work Item を sparse index で引き、Factory board の上限で止まった lane を続きから読む

- 状態: 提案
- 日付: 2026-11-25
- 関連: Issue #408、#365、[ADR 0006](0006-finished-run-index.md)、[ADR 0022](0022-work-item-notification-due-index.md)

## 背景

Factory board（`GET /api/teams/{teamId}/agent-runs`）は、`started` の Work Item を拾うために Team の
Work Item を更新の新しい順に最大 300 件読み、その中から `started` のものを選んでいた。status category の
index がないため、更新の多い Team では `started` の Work Item が 300 件の外に出て board から欠ける。
また、どの lane も上限で止まったことを `...HasMore` で示すだけで、続きを読む手段がなかった。

制約は次のとおり。

- 常時の固定費を増やさない（on-demand の読み書きだけ）。
- Work Item の status category を変える書き込みは、通知の期限 index（ADR 0022）の属性を
  `createWorkItemNotificationScheduleAttributes` / `createWorkItemNotificationScheduleUpdate` で同時に書く。
- client に渡す store の cursor は、別の Team の partition を読めないよう検証する必要がある。

## 決定

### started の sparse index

Work Items table に sparse GSI `TeamStartedWorkItemIndex` を追加する。

- partition key `startedDirectoryTeamId`: Work Item が `started` で archive されていない間だけ、row の
  `directoryTeamId` と同じ値を持つ。それ以外では属性を消し、index から外れる。
- sort key `updatedAt`（既存の属性）。board は更新の新しい順に読む。
- projection は `KEYS_ONLY`。board は候補の Work Item を強整合で読み直してから表示するため、index から
  本文は読まない。
- 属性は通知の期限 index と同じ関数で書く。期限 index の属性を書くすべての経路（作成、更新、依存関係の
  日程連鎖、file 承認による完了）で同時に保守され、新しい書き込み経路を足しても片方だけ漏れることがない。

### lane の続き読み込み

board の応答に opaque な `continuation` を追加する。上限で止まった source（active Run、24 時間以内の
終了 Run、失敗 Run、started の Work Item）ごとの store cursor と、最初の page が使った「24 時間」の
起点を持つ。`GET /api/teams/{teamId}/agent-runs?continuation=...` は、token にある source だけを cursor から
続けて読み、次の token を返す。Web は「続きの Run とタスクを読み込む」で次の page を足し、Work Item が
複数の page に出た場合は先に読んだ方を使う。

store の cursor は DynamoDB の key を含み、page は閲覧できない Work Item の行で止まることもあるため、
token は server の cursor secret から導いた鍵で AES-256-GCM により暗号化・認証し、Workspace・Team・
閲覧者を認証データに含める。client は中身を読めず、作り替えた token や別の閲覧者・Team の token は
`400` で断る。復号後も version、文字数、時刻を検証し、store の cursor は各 store が自分の Team の
partition に束縛されていることを確かめる。

## 検討した選択肢

- 選択肢 A（採用）: 期限 index と同じ関数で started の sparse GSI の属性を書く。
  利点: 書き込み経路を 1 か所で保守できる。GSI は on-demand で、`started` の Work Item だけが載る。
  欠点: 関数の名前が通知の期限 index を表しており、board 用の属性も書くことが名前から分からない
  （TSDoc で明記する）。
- 選択肢 B: 既存の `TeamIssueUpdatedAtIndex` の Query に `statusCategory` の filter を付ける。
  利点: index を増やさない。欠点: filter は読んだ後に適用されるため、読み取り量は Team の Work Item の
  総数に比例したままで、上限の問題が解決しない。
- 選択肢 C: board の応答を source ごとの独立した API に分ける。利点: paging が単純になる。
  欠点: Web が lane ごとに別々に読むため、同じ Work Item の Run や report を重複して読む。今の 1 応答の
  形と lane 判定の共有をやめることになる。

## 結果

- `started` の Work Item は、他の status category の Work Item の数に関係なく、最大 300 件まで 1 page で
  読める。上限で止まった lane は続きを読める。
- 既存の row は、次に書き込まれたときに属性が付く。`started` のまま更新されない既存の Work Item への
  付与は #365 の migration 契約で行う。AWS 環境はまだないため、初回 deploy 時点で属性のない row は
  存在しない。CDK の demo seed は同じ属性を書く。
- 更新した文書: `docs/software-factory.md`（Slice 4 の実装状況）、`docs/guide/` の Factory board の説明。
