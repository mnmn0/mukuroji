# 0032. 日本の祝日を内閣府の CSV から月に1回取り込み、tenant administration table の共有 row に置く

- 状態: 提案
- 日付: 2026-11-21
- 関連: Issue #634、PR #655、[docs/workspace-calendar-holidays.md](../workspace-calendar-holidays.md)

## 背景

#634 で日本の祝日を Work Item の稼働カレンダーに入れることにした。最初は祝日法と国立天文台の暦要項から作った
祝日を `contracts` に同梱したが、翌年分を足すたびに release と deploy が要る。翌年の祝日は毎年2月ごろに
公表され、法改正で祝日が変わることもある（2019〜2021 年の改正など）。祝日のためだけにアプリを更新しないで
済むようにしたい（2026-11-21 Shinji）。

内閣府は「国民の祝日」の一覧を CSV（Shift_JIS、`YYYY/M/D,名称`）で公開していて、翌年分も公表後に載る。
e-Gov データポータルにも登録されている。

## 決定

- **取得**：既存の scheduled-jobs Lambda に `japanese-public-holiday-sync` job を足す。6 時間ごとに起動し、
  保存済みの一覧が今月（日本時間）に取得したものでなければ CSV を取りに行く。月初の最初の起動で取り込み、
  失敗したら次の起動（6 時間後）でまた試す。新しい Lambda や EventBridge rule は作らない。
- **検証**：CSV は全行を読めた場合だけ使う。2020 年以降を残し、各年に 15〜25 日の休日があること、
  今年（日本時間）まで載っていることを確かめる。満たさない一覧は保存せず、job を失敗させて DLQ に残す。
  取得は HTTPS のみ、redirect を拒否し、512 KB と 15 秒で打ち切る。
- **保存**：tenant administration table の `workspaceId = system#public-holidays`、`recordKey = JAPAN` の
  1 行に、日付と名称の配列・取得時刻・取得月・取得した bytes の SHA-256 を置く。Workspace ID は `user#…` などの
  directory ID なので、この partition と重ならない。tenant operation の stream filter は
  `OPERATION#` などの row しか拾わないので、この row は worker を起こさない。job の IAM は `GetItem` /
  `PutItem` を `dynamodb:LeadingKeys = system#public-holidays` に限る。scheduled-jobs role の customer-managed
  policy は上限の 10 本に近いため、この 1 statement は shared role の inline policy に置く。
- **利用**：API は保存済みの一覧を読んで 1 時間 process 内に保持し、新しい Work Item の calendar policy と
  `GET /api/workspace/calendar-settings` の `nationalHolidayDates` に使う。Web はその日付で policy を作り、
  Gantt を網掛けする。
- **フォールバック**：まだ取得していないときは同梱の祝日を使う。保存済みの一覧を読めないときは、その process が
  前に読んだ一覧、それもなければ同梱の祝日を使い、1 分後にもう一度読む。祝日の取得や読み取りの失敗で
  Work Item の作成は止めない。保存済みの一覧より後の年は同梱の祝日で補い、保存済みより前の年で終わる一覧は
  保存しないので、来年の祝日を失わない。

## 検討した代案

- **同梱データを GitHub Actions で定期更新する**：実行時に外部へ依存しないが、祝日が変わるたびに
  PR・review・deploy が要り、更新しないで済ませたいという要件を満たさない。
- **API が都度内閣府から取る**：内閣府の応答に Work Item 作成が左右され、request ごとに外部通信が増える。
- **専用の DynamoDB table / S3 object**：row 1 つのために table や bucket を増やすと、backup・restore drill・
  IAM の対象が増える。既存の tenant administration table は API が既に読み書きでき、PITR もある。
- **EventBridge の月次 rule**：scheduled-jobs は毎分の rule 1 本にまとめる方針（ADR 0010）なので、
  6 時間ごとの job が月に1回だけ取りに行く形にした。

## 影響

- 祝日の一覧は内閣府の公表データに従う。CSV の利用条件（出典の表示）に合わせ、docs と管理画面の説明に
  出典（内閣府「国民の祝日」について）を書く。CSV はリポジトリに含めず、各環境が実行時に取得する。
- 内閣府が CSV の形式を変えると取り込みは止まり、前回の一覧のまま動く。scheduled-jobs DLQ の alarm で気づける。
- 保存済みの Work Item の policy は作成時の祝日のままで、取り込み後に変わらない。
- 同梱の祝日はフォールバックとして残し、年1回の追加は必須ではなくなる。
