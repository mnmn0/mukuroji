# 0083. カレンダーフィードを token の hash で引き、読むたびに持ち主の現在の権限で組み立てる

- 状態: 提案
- 日付: 2026-11-24
- 関連: Issue #352, [ADR 0052](0052-personal-tokens-without-software-factory.md), [ADR 0024](0024-project-raid-log-storage.md)

## 背景

#352 で、担当タスクの期限や Project のマイルストーンを Google カレンダー・Outlook・Apple カレンダーに表示したい。
これらのカレンダーは iCalendar の URL を定期的に取りに来るだけで、ログインや `Authorization` header を送れない。
そのため URL 自体に秘密の token を入れる必要がある。一方で、完了条件として token を失効すると 404 になり、
権限を失った Project の予定が消えなければならない。コストはなるべく増やしたくない。

## 決定

- token は `base64url(workspaceId).base64url(32 byte の乱数)` とし、乱数部分の SHA-256 だけを保存する。
  URL は発行時の response に一度だけ返す。
- 保存先は既存の Planning table の Workspace partition とし、2 種類の行を持つ。
  - フィード行 `CALENDAR_FEED#<memberKey>#MEMBER` / `CALENDAR_FEED#<memberKey>#PROJECT#<teamId>#<projectId>`:
    持ち主、種類、対象の Team と Project、題名の言語、現在の token の hash、発行日時。
    メンバーごとに自分のフィードは 1 つ、Project のフィードは Project ごとに 1 つ（最大 50）。
  - token 行 `CALENDAR_FEED_TOKEN#<hash>`: フィード行の key だけを持つ。
- 発行・再発行・停止はフィード行・token 行・監査 event を 1 つの TransactWrite で書く。再発行は
  フィード行の hash を条件に置き換え、古い token 行を消す。停止は両方を消す。監査は
  `member.calendar_feed_issued` / `_rotated` / `_revoked` で、token と hash は記録しない。
- 発行の request に `Idempotency-Key` があるときは、既存の idempotency 行（Developer Platform table、
  response は暗号化）を予約し、response の receipt を同じ TransactWrite に入れる。応答を受け取れずに
  同じ key で再送すると、token を作り直さずに最初の URL を返す。同じ key で別の内容を送ると 409。
- 公開 route `GET /api/public/calendar-feeds/{token}.ics` は、token 行とフィード行を強整合で読み、
  hash が一致したときだけ使う。その上で毎回、持ち主を Public API の本人用 key と同じ方法
  （`resolveDeveloperCredentialPrincipal`、`work-items.read`）で現在の権限の principal にし、
  Work Item は `/api/work-items` と同じ access filter、マイルストーンと Cycle は Analytics と同じ
  `planning.read` の判定で絞る。Project のフィードで Project を読めなくなったとき、持ち主が active な
  メンバーでなくなったとき、Workspace を閉じたときは、未知の token と同じ 404 を返す。
- 応答は終日の `VALUE=DATE` event だけにする（Work Item・マイルストーン・Cycle はすべて日付だけで持つ）。
  Workspace の time zone は `X-WR-TIMEZONE` に書く。未完了で日付のある Work Item を最大 1,000 件、
  マイルストーンと Cycle を最大 300 件、Work Item の読み取りは最大 10 page までにする。
  10 page で読み切れないときは、予定の欠けたカレンダーを返さずに `413` を返す。
- 1 つのフィードは 5 分に 30 回までとし、既存の Developer Platform の rate limit 表を使う。
  `Cache-Control: private, max-age=300`、`Referrer-Policy: no-referrer`、`X-Robots-Tag: noindex` を付ける。
- Google / Outlook の API に書き込む provider 固有の同期（#352 の第 2 段階）はこの判断に含めない。

## 検討した選択肢

- token を HMAC で署名し、行を持たない: 保存は要らないが、失効のたびに失効リストか鍵の切り替えが要り、
  メンバーごとの再発行ができない。却下。
- 本人用 API key（ADR 0052）を URL に入れる: 既存の仕組みを使えるが、`work-items:write` を持つ token が
  カレンダーの設定やログに残る。読み取り専用で用途を限った別の token にした。
- 発行時点の予定を snapshot として保存して配る（#349 の共有リンクと同じ形）: 読むたびの計算は減るが、
  期限の変更が反映されず、権限を失っても予定が残る。完了条件を満たさないので却下。
- 新しい table を作る: 分離はできるが、IAM・backup・費用が増える。Planning table の既存の
  Query / GetItem / TransactWrite の権限で足りるので却下。

## 結果

- 期限の変更は、カレンダーが次に取りに来たときに反映される。取りに来る間隔はカレンダー側が決め、
  Google カレンダーは数時間かかることがある。
- URL を知っている人は持ち主と同じ範囲の予定（タイトルと日付）を見られる。漏れたときは再発行する。
  Workspace の閉鎖で Workspace partition を消すと、フィード行と token 行も消える。
- 1 回の読み取りで Planning graph 全体と、読める Team の Work Item を最大 10 page 読む。カレンダーの
  取得間隔は数十分から数時間なので、50 人規模の費用への影響は小さいと見込む。
- 同時に Project のフィードを発行すると、上限の 50 をわずかに超えることがある（件数の確認と書き込みを
  同じ transaction にしていない）。
- `docs/guide/member.md` の「予定を自分のカレンダーに表示する」と `server/README.md` を更新した。
