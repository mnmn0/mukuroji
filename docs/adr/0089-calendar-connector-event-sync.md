# 0089. Google Calendar / Outlook の予定を既存の connector link で双方向に同期する

- 状態: 提案
- 日付: 2026-11-24
- 関連: Issue #352, [ADR 0083](0083-signed-calendar-feeds.md)

## 背景

#352 の第 1 段階（ADR 0083）で、iCalendar の URL を読むだけのカレンダーフィードを用意した。
第 2 段階では、Google カレンダーと Outlook の予定と Work Item の日付を双方向に同期したい。
カレンダー側で予定を動かしたら Work Item の期限も動き、Work Item の期限を変えたら予定も動く必要がある。
Developer Platform には GitHub / GitLab 向けの connector の仕組み（OAuth 接続、外部リンク、inbound と outbound の
同期、poll、競合の記録、自分の書き込みを無視する origin marker）がすでにある。

## 決定

- 新しい外部リンクの種類 `calendar-event` を足し、Google Calendar と Outlook Calendar の connector だけが使える
  （installation の category が `calendar` のとき）。同期の仕組みは既存の `ConnectorSyncEngine` と外部リンクの
  行をそのまま使い、table や key の形は変えない。
- Provider の API は operator が設定する REST binding ではなく、組み込みの resource protocol で呼ぶ。
  - Google: Calendar API v3 の `calendars/primary/events`。
  - Outlook: Microsoft Graph の `me/events`。
  - 接続した account の既定カレンダーだけを使う。provider 設定に `resources` を書くと起動時に拒否する。
- 予定は終日の event として作り、終了日は exclusive で書く。Work Item の日付との対応は次のとおり。
  - 期限だけの Work Item は、その日 1 日の予定にする。
  - 期間のある Work Item は、開始日から終了日までの予定にする。
  - マイルストーン型の Work Item は、その日の予定にする。
  - 日付のない Work Item には予定を作らない。outbound の同期でも skip する。
- Mukuroji が作った予定には private な extended property `mukurojiManaged=1` を付ける。poll ではこの property で
  絞り、自分が作った予定だけを読む。outbound の origin marker も `mukurojiOrigin` に入れる。
- `calendar-event` のリンクは Mukuroji が作った予定だけにする。作成では `externalId` と `externalUrl` を受け付けず
  （`400`）、Work Item の日付で予定を作ってからリンクする。既存の予定は印がなく poll で読めないため。
  - Google では event ID を操作 ID の sha256 から決め、再送で 409 が返ったら同じ ID に PATCH する。
  - Outlook では `transactionId` を同じ値にする。
  - 予定の作成後にリンクの作成が失敗すると、予定だけが残ることがある。これは許容する。
- Inbound の同期で変えるのは日付だけにする。予定の題名を変えても Work Item の題名は変えない。
  - 期限だけの Work Item は、予定の最終日を期限にする。
  - 期間のある Work Item は、予定の期間に合わせて稼働日数を計算し直す。期間に稼働日がなければ
    `ConnectorCalendarDatesInvalid` で拒否する。
  - 日付のない Work Item は、予定が 1 日なら期限、複数日なら期間にする。
- 両側で日付が変わった場合は、既存の競合の記録で `schedule` の差分として残し、利用者に解決してもらう。
- 予定の version は provider の ETag（Google の `etag`、Graph の `@odata.etag`）とし、更新は `If-Match` で条件付きにする。
  最後に読んだ後で予定が動いていれば `412` になり、outbound は書かずに skip する。次の poll がその変更を読み、
  Work Item も変わっていれば競合として記録する。
- 予定を作って link を保存したら、作成に使った Work Item の revision と作成した予定を link の最初の同期状態として
  保存する。最初の poll より前に Work Item の日付が変わっても、作成時の日付へ戻さない。
- ETag は順序を持たないので、カレンダーの予定は保存済みの version と同じときだけ「変更なし」とみなす
  （他の connector の数値・文字列の大小比較は使わない）。
- 競合の解決中に予定が動いた場合（`412`）は、予定を 1 件読み直して競合の外部側の値と version を新しくし、
  解決をやり直してもらう。競合中の link は poll されないので、ここで読み直さないと古い ETag のまま失敗し続ける。
- 日付の競合は「マージ」で開始日と終了日を選び直せる。カレンダーの競合のマージは `schedule` だけ、他の
  connector の競合のマージは title・description・status だけを受け付ける。
- Graph は日時を UTC で返すよう `Prefer: outlook.timezone="UTC"` を送り、予定を書いたときの IANA time zone を
  extended property `mukurojiTimeZone` に記録して、読むときにその time zone の日付へ戻す。

## 検討した選択肢

- カレンダー専用の同期 worker と保存形式を作る: GitHub 用と同じ処理（lease、競合、poll の checkpoint）を
  もう一度作ることになる。既存の外部リンクの仕組みに resource protocol を差し込む形にした。
- 同期用の専用カレンダーを作る: 予定を分けられるが、利用者がカレンダーを追加で表示する設定が要り、
  カレンダーを作る権限も広くなる。既定カレンダーに印を付けた予定だけを扱う形にした。
- 時刻つきの予定にする: Work Item の日付は日単位なので、時刻を決める規則が要る。終日の予定にした。
- Provider の push 通知（Google の watch、Graph の subscription）で受ける: 通知の受け口と更新の管理が要る。
  既存の poll で十分なので、今回は入れない。

## 結果

- 個人のカレンダーに表示するだけなら、引き続きカレンダーフィード（ADR 0083）を使う。connector は Workspace の
  連携として、管理者が接続した account の既定カレンダーに予定を作る。
- 実 OAuth と実 API での確認（Google と Outlook の接続、Outlook の終日予定の time zone、Graph の
  `transactionId` による重複防止）は #636 の確認項目で行う。テストでは provider の応答を mock している。
- Public API の互換チェック（`public-api-compatibility`）は、外部リンクの response の `resourceType` に
  `calendar-event` が増えることで落ちる。ADR 0045 の webhook event type と同じく、チェックが落ちたまま
  管理者マージする扱いを Shinji に確認した。consumer は知らない `resourceType` のリンクを無視する、と
  `docs/public-api.md` に書いた。
- `docs/guide/admin.md` の Connector、`docs/public-api.md` の外部リンク、`cdk/README.md` の connector secret を更新した。
