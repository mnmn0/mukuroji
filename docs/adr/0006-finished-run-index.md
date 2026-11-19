# 0006. 終了済み Run を Team と終了時刻で引く sparse index を追加する

- 状態: 提案
- 日付: 2026-11-20
- 関連: Issue #408、#355、#365、[ADR 0003](0003-agent-run-latest-record.md)

## 背景

Factory board（`GET /api/teams/{teamId}/agent-runs`）は「完了（24 時間）」と「失敗」の lane のために、
Team の終了済み Run を table の `agent-run#<runId>` 順に最大 500 件読んでいた。Run の row は Work Item と
ともに残るため、稼働している Team では数週間で 500 件を超え、直近の完了や未解決の失敗が lane から欠ける。
上限で止まったことは `finishedRunsHasMore` で示すだけで、続きを読む手段もない。

制約は次のとおり。

- 常時の固定費を増やさない（on-demand の読み書きだけ）。
- board の読み取り量を Team の Run の総数に依存させない。
- Run を閉じる経路（finish、release、take over、Work Item の削除・archive）はすべて
  `createCloseItems` の transaction を通る。

## 決定

`AgentRunsTable` に sparse GSI `FinishedRunIndex` を追加する。

- partition key `finishedRunPartition`: `failed` で終了した Run は `<directoryTeamId>#failed-run`、
  それ以外の outcome は `<directoryTeamId>#finished-run`。
- sort key `finishedRunSortKey`: `<finishedAt>#<runId>`。
- projection は `INCLUDE`（`runId`、`workItemId`、`outcome`、`finishedAt`）。board は Work Item ごとの
  最新 Run を `WorkItemRunIndex` と強整合の読み直しで決めるため、index から Run 全体は読まない。
- key は Run を閉じる transaction の update で書く。`active` の Run は key を持たない。

board は 2 つの partition を終了の新しい順に読む。`finished-run` は直近 24 時間の範囲だけを
key 条件で読み、`failed-run` は時期を問わず読む。どちらも 500 件で止め、止まった場合は従来どおり
`finishedRunsHasMore: true` を返す。

失敗を別 partition にするのは、失敗 lane が期限なしで失敗を残すためである。同じ partition だと、失敗を
拾うために 24 時間より前の完了 Run もすべて読む必要がある。

## 検討した選択肢

- 選択肢 A（採用）: Team と終了時刻の sparse GSI を 1 つ追加し、失敗を別 partition にする。
  利点: 読み取りが直近 24 時間の終了数と失敗数だけに比例する。GSI は on-demand で固定費がない。
  #355 の analytics も同じ index で Team の終了済み Run を期間で読める。
  欠点: 解決済み（後続 Run がある、Work Item が完了した）の失敗も `failed-run` に残るため、失敗の総数が
  500 件を超える Team では古い未解決の失敗が欠けうる。
- 選択肢 B: 未解決の失敗だけを持つ sparse key にし、後続 Run の start や Work Item の完了で key を外す。
  利点: 失敗 partition が未解決の数だけになる。欠点: start の transaction と Work Item の status 変更に
  別 module の Run row 更新を足す必要があり、claim の不変条件に関わる transaction が大きくなる。
  失敗が溜まる実績を見てから A の上に足せる。
- 選択肢 C: board の上限を引き上げる。欠点: 読み取り量が Run の総数に比例したままで、解決しない。

## 結果

- 終了済み Run が何件あっても、直近 24 時間の完了と、500 件以内の失敗は board に出る。
- index の key は新しく閉じた Run にだけ付く。既存の終了済み Run への付与は #365 の migration 契約で行う。
  AWS 環境はまだないため、初回 deploy 時点で key のない Run は存在しない。
- `started` の Work Item を更新順の先頭 300 件に依存せず読む index と、API の paging は #408 の残りとして
  別の変更で扱う。
- 更新した文書: `docs/software-factory.md`（永続化の index 表、Slice 4 の実装状況）。
