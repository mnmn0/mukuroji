# 0096. メンバーの最終ログインを member row に version を変えずに記録し、owner と admin にだけ返す

- 状態: 提案
- 日付: 2026-11-24
- 関連: Issue #432、ADR 0074

## 背景

全社に展開すると、管理者は招待したまま使われていないアカウントや、しばらくログインしていない
メンバーを探す必要がある。メンバー一覧（`GET /api/workspace/access`）には参加日時と更新日時しかなく、
最後にログインした時刻はどこにも保存していなかった。Cognito の user には最終ログインの属性がなく、
`AdminGetUser` を全員分呼ぶのは一覧の表示に見合わない。

ログインは `createAuthenticationResponse` を通り、そこで `reconcileAuthenticatedMember` が
Workspace Access table の member row（`MEMBER#<memberKey>`）を読む。token の refresh も同じ関数を
通るが、`continuation` で区別できる。member row の更新は `version` を条件にした transaction で行い、
role・名前・利用状態の変更は `version` の ConditionCheck で互いの競合を検出している（ADR 0074）。

## 決定

- 新しいログイン（パスワード、MFA、新しいパスワードの設定、SSO の callback）のたびに、
  member row に `lastSignedInAt`（ISO 8601、UTC）を `UpdateItem` で書く。条件は
  「row がある・`status = active`・既存の値より新しい」。`version` と `updatedAt` は変えない。
- token の refresh は新しいログインではないので書かない。refresh の request に以前の access token が
  なくても、refresh として扱う。
- 記録に失敗してもログインは失敗にしない（ログに残す）。表示の参考値であり、ログインを止める理由にならない。
- `lastSignedInAt` は `getAccessSnapshot` だけが読み、閲覧者が owner か admin のときだけ member に付けて返す。
  `toWorkspaceMember` は読まないので、ほかの API や module が返す member には出ない。
  保存値が正しい timestamp でなければ「記録なし」として扱い、一覧を失敗にしない。
- 新しい table、index、stream、IAM 権限は追加しない（API はこの table の読み書き権限を持っている）。

## 検討した選択肢

- 選択肢 A: 別の sidecar row（`MEMBER_SIGNIN#<memberKey>`）に置く。member row を一切変えない /
  一覧で別の prefix の Query が要り、member を消す・復元する経路でも sidecar を扱う必要がある。
- 選択肢 B: member row を `version` 付きで更新する。ほかの更新と同じ規則にそろう / ログインのたびに
  `version` が上がり、同時に role や名前を変えようとした管理者が理由なく 409 になる。
- 選択肢 C（採用）: member row の属性を `version` を変えずに条件付きで更新する。読み取りは今の Query の
  ままでよく、ほかの更新と競合しない / `version` が変わらないので、この値の変更は同時更新の検出対象に
  ならない（参考値なので受け入れる）。
- 選択肢 D: refresh でも更新して「最終利用」にする。長い refresh token で使い続ける人も新しく見える /
  1 時間ごとに書き込みが増え、「ログイン」と呼べなくなる。

## 結果

- 管理者はメンバー一覧で最終ログインを見て、古い順に並べ替え、CSV にも書き出せる。
- この機能を入れる前のログインは記録されていないので、最初は全員「記録なし」になる。
- refresh token でログインしたまま使い続ける人は、最終ログインが古いままに見える。ガイドに書く。
- 利用者ガイド（`docs/guide/admin.md`）の「メンバーを探す・書き出す」を更新する。
