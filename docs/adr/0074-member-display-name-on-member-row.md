# 0074. メンバーの表示名を member row に保存し、本人と管理者が条件付き更新で変える

- 状態: 提案
- 日付: 2026-11-23
- 関連: Issue #431、ADR 0007

## 背景

担当者の一覧・コメント・週報・通知に出る名前は `WorkspaceMember.name` で、招待時の値か、
membership を作るときの Cognito `name` 属性から入る。メンバー本人も管理者もあとから変えられなかった。
ADR 0007 で表示設定は sidecar row にしたが、表示名は member row 側の判断として残していた。

ログイン時の `reconcileAuthenticatedMember` は、有効な member が既にいればその row をそのまま返す。
Cognito の `name` を読むのは membership を作るときだけで、その後のログインで上書きはしない。
directory（SCIM）連携の member は、reconcile のたびに directory の値で `name` を上書きする。

## 決定

- 表示名は引き続き member row の `name` に置き、名前の正本とする。担当者の一覧・コメント・通知など
  多くの経路は既にこの値を読む。Project member row の `name` と Cognito の `name` は書かれた時点の
  値のままなので、それを読んでいた経路（Project メンバー一覧、週報の提出状況と未提出リマインダー、
  Analytics の export）は Workspace member row の名前を優先し、member row にない人だけ従来の値を使う。
  通知 schedule は名前を読むため Workspace Access table の `Query` 権限を足す。
- 本人は `PUT /api/me/profile`、管理者は `PUT /api/workspace/members/:memberKey/name` で変える。
  `GET /api/me/profile` は本人の表示名・メール・`nameEditable`・`version` を返す。
- 権限は role 変更と同じ: 本人は自分、owner は全員、admin は member と guest。
  管理者の更新は actor row の status・role・version を transaction の ConditionCheck で固定する。
- 更新は member row の `version` を条件にした transaction で行い、`version` を 1 上げる。
  directory 管理の member（`provisioningSource = directory`）は 409
  `WorkspaceMemberNameDirectoryManaged` で断り、条件式でも読み取り後に directory 管理へ変わった row を守る。
- 応答が届かず同じ `Idempotency-Key` で再送された変更は、同じ transaction で書いた audit event
  （ID は idempotency key から決まり、request fingerprint は名前と `expectedVersion` を含む）で検出し、409 にせず保存後の member を返す。
  同じ key で別の名前を送った場合は 409 `WorkspaceIdempotencyConflict` にする。
  今と同じ名前を送った変更も member row は変えずに、version の ConditionCheck と項目の変更がない
  audit event を書き、key を入力に結び付ける。
- 名前を表示に足すだけの読み取り（Work Item の担当者、Factory board、Analytics の export）は、
  Workspace member row を読めなかったときも応答を失敗にしない。Work Item と board の担当者は
  古いかもしれない Cognito の名前を出さずメールで、export は Project row の名前で出す。
  export が名前を出すのは閲覧できる Project にいる member だけにする。
- 週報の roster は無効化された member の名前も Workspace member row から読む。
- 名前は前後の空白を除いて 128 文字まで、制御文字を含めない。空は名前を消し、メールで表示する。
- Cognito の `name` 属性は変えない。ログインで上書きされず、Cognito への書き込みと IAM 権限を増やさずに済む。
- 変更は監査ログに `member.renamed` として書く。名前は既存の member 監査と同じく伏せる。

## 検討した選択肢

- 選択肢 A: member row とは別の profile row に表示名を置き、読む側で上書きする。
  member row の条件付き更新に触れない / 名前を読む経路を全部変える必要があり、漏れると古い名前が出る。
- 選択肢 B: Cognito の `name` も同時に更新する。ID token の名前もそろう /
  API に `AdminUpdateUserAttributes` の権限が要り、enterprise SSO の利用者は Cognito 側の値が
  IdP から上書きされる。アプリは ID token の名前を表示に使っていない。
- 選択肢 C（採用）: member row の `name` を version 条件付きで更新する。読む側は変えずに済む /
  名前の変更でも member の `version` が上がるので、同時に role を変えようとした管理者は 409 になって読み直す。

## 結果

- メンバーは自分の表示名を、管理者はほかのメンバーの表示名を設定画面から変えられる。
- SCIM の member は directory 側で名前を変える必要がある（画面では入力欄を止めて理由を出す）。
- ID token や Cognito の画面には元の名前が残る。表示には使わないので影響はない。
- 利用者ガイド `docs/guide/member.md`「表示と言語」と `docs/guide/admin.md`「メンバーの表示名を直す」を更新した。
