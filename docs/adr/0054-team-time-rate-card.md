# 0054. 工数の単価表を Team ごとの `TIME_RATE_CARD` row で持ち、Workspace の既定通貨を tenant profile に置く

- 状態: 提案
- 日付: 2026-11-22
- 関連: Issue #398

## 背景

これまで工数の時間単価（`hourlyRateMinor`）は、manager が entry ごとに入力するしかなかった。
単価を入れ忘れた工数は原価が付かず、予算対比（#345）に使えない。
また、entry・timer・予算の通貨は、要求が通貨を省くと `USD` になっていた。日本の会社では円で記録したい。

## 決定

### 単価表

工数 table（analytics table を共有、partition key `workspaceId`）に、Team ごとの
`TIME_RATE_CARD#<teamId>` row を 1 件置く。row は通貨と、次の 2 種類の行を持つ。

- メンバーの行: メンバー（member key）ごとに、本人の時間単価、ジョブロール、またはその両方。
- ジョブロールの行: Work Item configuration のジョブロール ID ごとの時間単価。

単価を指定せずに作った entry と、単価を指定せずに止めた timer の entry には、作るときに単価表を読んで
**本人の単価、なければ本人の行のジョブロールの単価** を入れる。適用したときは entry の通貨も単価表の通貨にする。
保存済みの entry は単価表を変えても変わらない（作ったときの単価が残る）。manager が単価を入力したときはそれを優先する。

- 単価表は表全体を置き換える `PUT /api/teams/:teamId/time-rate-card` で保存し、`revision` で楽観的排他を取る。
  shared audit event（`time-rate-card.updated`）と idempotency receipt を同じ TransactWrite で書く。
  audit の差分では行（単価）を伏せ、件数だけを metadata に残す。
- 読み書きできるのは Team 全体の manager（システム管理者、または Team の管理権限）だけにする。単価表は全員の単価を持つので、
  一部の Project の manager には見せない。entry に入った単価と原価は、これまでどおり confidential cost の規則で、
  その entry の Project の manager にだけ返す。
- 誰が単価表を管理できるか、と Workspace の通貨は `GET /api/teams/:teamId/time-tracking/settings` で Team の viewer に返す。

### 既定通貨

tenant profile に `defaultCurrency`（ISO 4217）を追加し、Workspace の owner / admin が既存の
`PATCH /api/tenant/profile` で変える。保存していない Workspace は `JPY`（`DEFAULT_WORKSPACE_CURRENCY`）とする。
entry の作成・timer の停止・予算の保存で要求が通貨を省いたときはこの通貨を使う。新しい deploy は何も設定しなくても JPY になる。

## 検討した選択肢

- Work Item の contributor のジョブロールから単価を引く: 同じ人でもタスクごとに単価が変わり、entry を作るたびに
  Work Item を読む必要がある。timer の停止では Work Item の権限を確かめ直すことにもなる。メンバーの既定ジョブロールを
  単価表に持つ形にした。
- メンバーごとの row に分ける: 1 件ずつ変えられるが、entry を作るたびに 2 件（本人とジョブロール）読むことになり、
  一覧を出すには query が要る。Team の単価表は数百行に収まるので 1 件にした（上限はメンバー 500 行、ジョブロール 100 行）。
- 単価表の変更を保存済みの entry に遡って反映する: 承認・締め済みの原価が後から変わってしまう。作ったときの単価を残す。
- 通貨を deploy のパラメータにする: Workspace ごとに変えられず、deploy し直しが要る。tenant profile に置いた。

## 結果

- 単価表を 1 か所で決めると、新しい工数の原価が自動で付く。単価を入力する manager の手間と入れ忘れが減る。
- entry の作成と timer の停止で、単価を指定しないときに単価表の GetItem が 1 回増える。
  通貨を省いた要求では tenant profile の GetItem も 1 回増える。
- 単価表の読み取りは書き込み transaction の外なので、単価表の保存とほぼ同時に作った entry は古い単価になりうる。
- ジョブロール ID は形式だけを確かめる。Work Item configuration から消えたジョブロールの行は、画面では ID のまま表示し、消せる。
- 新しい table・index・IAM はない（既存 table の GetItem / PutItem / TransactWrite だけ）。
- 更新した文書: `docs/time-tracking.md`、`docs/guide/pm.md`、`docs/guide/admin.md`。
