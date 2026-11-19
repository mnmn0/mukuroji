# 0007. メンバーの表示設定を project directory table の sidecar row に保存する

- 状態: 提案
- 日付: 2026-11-19
- 関連: Issue #431

## 背景

言語・配色・文字サイズはブラウザの `localStorage` にだけ保存していたため、別の端末では
既定値から始まっていた。通知や digest を受信者の言語と time zone で作るためにも、
server がメンバーごとの値を知っている必要がある。

メンバーごとの小さな設定は、既に Project quick access が project directory table の
sidecar row（`PROJECT_QUICK_ACCESS#<workspace>#<member>` / `PREFERENCE`）として持っている。

## 決定

メンバーの表示設定（`locale`・`timeZone`・`theme`・`fontSize`）を、project directory table に
次の key の sidecar row として 1 件ずつ保存する。

- partition key `directoryId`: `MEMBER_PREFERENCES#<encodeURIComponent(workspaceId)>#<encodeURIComponent(memberKey)>`
- sort key `entryKey`: `PREFERENCE`
- `entryType`: `member-preferences`

更新は全項目の置き換えとし、`revision` による compare-and-swap で古い更新を 409 にする。
API は認証済みメンバー本人だけが読み書きする `GET` / `PUT /api/me/preferences` で、
key は token から解決した Workspace と member key だけから作る。
cross-domain integrity の scanner はこの row を既知の補助 row として検証する。

## 検討した選択肢

- 選択肢 A: `WorkspaceMember` の row に項目を足す。表示名と同じ場所に置ける / member row は
  role・status・認可 generation の条件付き更新が多く、どの経路でも新しい項目を消さないことを
  確かめる範囲が広い。表示設定の更新が認可の version を動かしてしまう。
- 選択肢 B: 新しい table を作る。分離は明確 / table・IAM・backup・CDK の変更が増え、費用と運用の対象も増える。
- 選択肢 C（採用）: quick access と同じ sidecar row にする。既存の table・権限・整合性検査の
  仕組みに乗れて、member row の認可には触れない / メンバーを外しても row は残る（quick access と同じ）。

## 結果

- 新しい端末でも保存済みの言語・配色・文字サイズで始まり、server が受信者の locale と
  time zone を読めるようになる。
- メンバー削除時に row は残る。値は表示設定だけで、権限には使わない。必要になったら
  削除時の cleanup を追加する。
- 表示名の変更は member row（`WorkspaceMember.name`）側の判断として別に扱う。
- 利用者ガイド `docs/guide/member.md` の「表示と言語」を更新した。
