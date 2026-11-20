# 0020. 工数の月次締めを Team ごとの `TIME_CLOSE` row で持つ

- 状態: 提案
- 日付: 2026-11-19
- 関連: Issue #398

## 背景

工数の実績を原価と予算対比に使うには、締めた月の記録が後から変わらないことが前提になる。
これまでは entry ごとの `locked` しかなく、締めた月の日付で新しい entry を作る、
まだ approved でない entry を直す、といった変更を止める仕組みがなかった。

## 決定

工数 table（analytics table を共有、partition key `workspaceId`）に、Team と月ごとの
`TIME_CLOSE#<teamId>#<YYYY-MM>` row を追加する。row は月の境界を決める IANA timezone、締めた人、締めた時刻を持つ。

- 締めは `attribute_not_exists(recordKey)` を条件に put し、同じ月の二重の締めは `409` にする。
  解除は締めた時刻が読んだ値と同じことを条件に delete する。どちらも shared audit event と同じ TransactWrite で書く。
- entry の作成・編集・timer の停止・ロック以外の状態遷移は、書き込みの前に Team の締め row を強整合の
  prefix query で読み、entry の区間が締めた月（timezone での月初から翌月初まで）にかかれば `409 TimePeriodClosed` にする。
  編集は変更前と変更後の両方の区間を確かめる。
- 読んだ後に締めや解除が入った書き込みを止めるため、entry の TransactWrite の先頭に、区間がどこかの timezone でかかりうる月
  （UTC で区間の前後 14 時間まで）の締め row ごとの ConditionCheck を入れる。読んだときに無かった月は `attribute_not_exists`、
  あった月（区間にはかからない）は締めた時刻が読んだ値と同じことを条件にする。これが失敗したら `409 TimePeriodClosed` にする。
  entry は最長 7 日なので、ConditionCheck は 1 回の書き込みで数件に収まる。
- 締めは Team 単位とし、Workspace 単位の締めは持たない。

## 検討した選択肢

- 締めた月の entry をすべて `locked` に一括更新する: 既存の状態だけで表せるが、締めた後に作られる entry を止められず、
  解除のときに元の状態へ戻せない。
- 締め row を読まずに、entry の書き込み transaction の ConditionCheck だけで確かめる: timezone によって entry が
  かかる月の row を事前に絞れず、かからない月の row があるだけで誤って拒否しうる。読んだ結果を条件に使う形にした。
- Team ごとの世代番号 row を締め・解除で上げ、entry の書き込みで世代を確かめる: ConditionCheck は 1 件で済むが、
  無関係な月の締めでも書き込みが競合する。

## 結果

- 締めた月の記録は API から変更できなくなり、解除の理由は監査ログに残る。
- 締めとちょうど同時に書かれた entry は、締めた月に入らず `409 TimePeriodClosed` で拒否される。
  区間にかからない月の締め・解除と重なった書き込みも拒否されるので、読み直して送り直せばよい。
- 書き込みのたびに Team の締め row を 1 回 query する。row は月に 1 件なので件数は小さい。
- 更新した文書: `docs/time-tracking.md`、`docs/guide/member.md`、`docs/guide/pm.md`。
