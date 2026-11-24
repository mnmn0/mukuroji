# 0069. Workspace のポートフォリオを Team ごとに読み、月次 snapshot を Team と月ごとの Planning row で持つ

- 状態: 提案
- 日付: 2026-11-23
- 関連: Issue #343、Issue #341、Issue #388、ADR 0016、ADR 0024、ADR 0027、ADR 0043、ADR 0054

## 背景

Issue #343 で、PMO が Workspace 全体の Project を健全性・進捗・ベースライン遅延・予算消化・
リスク・次のマイルストーンで横並びに比べ、前月と比べられるダッシュボードを作ることになった。
前提は次のとおり。

- Project の数字は Project 概要（#341）と週報（ADR 0030）がすでに Team 単位で読んでいる。
  Work Item は Team の要約 scan（上限あり）、ベースラインは Project ごとの行（ADR 0016、0043）、
  リスク・課題は登録簿（ADR 0024）、予算と工数は time-tracking（ADR 0027、0054）にある。
- 費用は、Team の工数管理者で、かつシステム管理者かその Project の管理者である人にだけ見せる
  （工数の集計と同じ基準）。閲覧権限のない Project は存在も返さない。
- Workspace 全体を一度に読む API はなく、DynamoDB の全件 scan はしない方針。
- Analytics の snapshot store は Work Item query の hash に結び付いていて、Project ごとの
  指標を月で持つ用途には合わない。

## 決定

- 読み取りは Team ごとの `GET /api/teams/:teamId/portfolio` にする。Web は Workspace の Team を
  6 件ずつ並行に読み、失敗した Team だけを画面で名指しし、ほかの Team は表示を続ける。
- 上限を超えたら黙って切らずに断る（fail-closed）。Team あたり Project 200 件、Work Item は
  既存の要約 scan の上限、予算期間内の工数は 20,000 件、Workspace あたり Team 100 件まで。
  工数は予算期間が同じ Project ごとにその期間だけを読み、期間外の工数は上限に数えない。
  超えた場合は API が 413 `PortfolioTooLarge` を返し、Web は Team 数超過を通知して読まない。
- 返すのは読める Project の指標だけで、読めない Project は `hiddenProjectCount`、費用を見せない
  Project は `costHiddenProjectCount` と各行の `costHidden` で件数だけを返す。
- 月次 snapshot は Planning table に Team と月ごとの 1 行
  `TEAM_PORTFOLIO_SNAPSHOT#<encodeURIComponent(teamId)>#<YYYY-MM>`（`entryType:
  team-portfolio-snapshot`、`schemaVersion: 1`）で持つ。行には Project ごとの指標（費用を含む）を
  そのまま入れ、350,000 byte を超える場合は 413 で保存を断る。
  行は保存のたびに 1 から増える `revision` を持ち、保存は計算の前に読んだ revision の次としてだけ
  書ける（条件付き Put）。後から始めた保存が先に終わった場合、遅れた方は 409 で断り、新しい snapshot を
  古い計算で上書きしない。
  保存要求ごとに `TEAM_PORTFOLIO_SNAPSHOT_RECEIPT#<teamId>#<Idempotency-Key のハッシュ>` の受領行を
  同じ transaction で書き、応答が失われて同じ key で再送されたときは計算し直さずにその月の snapshot を返す。
  同じ key で別の要求が来たら 409 `PortfolioSnapshotIdempotencyConflict` にする。受領行は消さない。
- 保存は `PUT /api/teams/:teamId/portfolio/snapshots/:month` で、`teams.manage` の操作として扱い、
  Team 全体を管理している人だけができる。システム管理者か、Team の全 Project を読めて費用も見られる
  工数管理者で、Team への直接の権限があっても読めない Project や費用の見えない Project が1つでもあれば
  保存できない（保存した snapshot がその月の比較を全員分置き換えるので、一部だけの snapshot で
  上書きさせない）。Project のない Team は Team への直接の管理権限で保存できる。保存できるのは閲覧者の timezone での今月だけで、同じ月に
  もう一度保存すると上書きする。受領行の照合には月と timezone を含め、同じ key で timezone だけ
  変えた要求も別の要求として 409 にする。書き込みは呼び出し元の権限 fence、Team が archive されて
  いないことの条件、監査イベント
  `team.portfolio_snapshot_saved`（月と Project 数だけを記録）を同じ transaction に入れる。
- snapshot を読むときは、読む人の今の権限で Project と費用を伏せ直してから返す。保存した人の権限で
  見えていた Project や費用は、読む人に権限がなければ返さない。
- 自動の月次保存は作らない。前月比は手動で保存した snapshot だけを使う。

## 検討した選択肢

- Workspace 全体を 1 回で返す API: 1 回の request が Team 数に比例して重くなり、1 つの Team の失敗で
  全体が見えなくなる。Team ごとの API は既存の Team 権限確認をそのまま使える。
- Analytics の snapshot store を使う: Work Item query の hash 単位で、Project ごとの指標や費用の
  伏せ直しを持てない。
- snapshot を Project ごとの行に分ける: 1 回の保存の書き込み数が Project 数に比例し、transaction の
  上限（100 件）にも当たる。1 Team 200 Project なら 1 行に収まる。
- scheduler で毎月自動保存する: 保存する権限の主体（system actor）と、費用を含む行の扱いを別に決める
  必要がある。手動保存で前月比の要件は満たせるので見送る。

## 結果

- PMO は Team を横断して Project を比べ、前月と比べられる。権限のない Project と費用は件数だけ見える。
- 1 Team の Project が 200 件を超えると、その Team のポートフォリオは読めない。超えたら Team を
  分けるか、上限を見直す。
- snapshot の行は費用を含むので、読み出しは必ず伏せ直しを通す。新しい読み出し口を足すときも同じ。
- 要員稼働率は Web が `GET /api/workload`（ADR 0068）の今月分を 1 回読み、Project ごとに割り当てのある
  メンバーの Workspace 横断の割り当てと稼働可能時間を合計して出す。Team の portfolio API と snapshot には
  入れない（Team ごとに全 Team の capacity record を読むことになるため）。前月比は出さない。
- 顧客での絞り込みは、Project の顧客項目ができてから足す。
- 利用者ガイド `docs/guide/pm.md` にポートフォリオダッシュボードの説明を足す。
