# 0088. 依頼者ごとの索引行を Request Intake table に置き、依頼者への通知を scope なしの event で届ける

- 状態: 提案
- 日付: 2026-11-24
- 関連: Issue #391、ADR 0021、ADR 0064

## 背景

社内向けフォームから依頼を送った member が、自分の依頼の状況、チームからの質問、作られた
Work Item を確かめ、状況が変わったら受信箱で知る必要がある。依頼者はふつう Triage を行う
Team や Work Item の Project に所属していない。これまでの通知は Team・Project・Work Item の
scope を持ち、配信時と読み取り時にその scope の閲覧権限を確かめるため、そのままでは依頼者に
届かない。逆に scope を外すと、依頼者が読めない Team 内部の情報（却下理由、担当者、回答、
Work Item のタイトル）が通知に混ざる危険がある。

Submission は `RequestIntakeTable` に Workspace 単位で保存されているが、送信者で引く手段が
なく、scan は Workspace の依頼件数に比例する。

## 決定

- `auth-required` / `internal` link で signed-in member が送った submission にだけ、正規化した
  member key を `requesterUserId` として保存する。`public` link では session があっても記録しない。
- 同じ transaction で `WORKSPACE#<workspaceId>` partition に
  `REQUESTER#<memberKey>#SUBMISSION#<submissionId>` の索引行（`requester-submission`）を書く。
  Submission ID は時刻順なので、1回の Query の降順で新しい順に読める。索引行は `workspaceId`
  を持ち、tenant の export / delete の対象に入る。新しい GSI は作らない。
- 依頼者 API（`/api/my-requests`）は保存された `requesterUserId` と認証済み member の一致で
  所有を判定し、一致しないものは `404` にする。返すのは form title、状況、受付番号、thread だけ。
- 依頼者への通知は `request.requester.<kind>` の audit outbox event とし、Team・Project・
  Work Item の scope を持たせない。中身は form title と contracts の定型文、deep link は
  `/my-requests` に限る。Collaboration projection は scope のない requester event を reason
  `requester` の候補（Workspace を読める member）だけに配り、受信箱は読み取り時に submission が
  まだその member のものかを確かめる。
- Work Item の完了は、Form から作った Work Item に API へ返さない `sourceRequester`
  （member key と form title）を持たせ、完了遷移の transaction で通知を書く。Work Items の
  処理から Request Intake table を読まない。
- Work Item の中身は、依頼者が現在 viewer として読める場合だけ表示し、読めない場合は完了したか
  どうかだけを返す。
- 依頼者への通知は受信箱だけに届け、member の channel 設定にかかわらず Email・Slack・Push には送らない。

## 検討した選択肢

- Submission に GSI（requester, createdAt）を足す: 索引行と同じ読み方ができるが、table 定義の
  変更と既存 row への射影が要る。索引行なら既存の primary key で済み、tenant 操作の仕組みにも乗る。
- 通知に Team scope を付けたまま依頼者を例外で通す: 権限確認の分岐が増え、Team 内部の通知と
  依頼者向け通知の内容が混ざりやすい。scope なしの専用 event にすると、見せてよい内容を event
  作成時に固定できる。
- 完了時に Work Items 側から Request Intake table を読んで依頼者を探す: Work Items の処理に
  別 table の読み取り権限が増える。作成時に写しを持つ方が IAM の範囲を変えずに済む。

## 結果

- 依頼者は Team や Project の権限がなくても、自分の依頼の状況と通知を受け取れる。通知と API には
  Team 内部の情報が入らない。
- 既存の submission には `requesterUserId` も索引行もないため、この変更より前に送った依頼は
  「自分の依頼」に出ない。backfill はしない。
- Work Item の `sourceRequester` は作成時の写しなので、form title の後の変更は通知に反映しない。
- 更新した文書: `docs/request-intake.md`、`docs/guide/member.md`。
