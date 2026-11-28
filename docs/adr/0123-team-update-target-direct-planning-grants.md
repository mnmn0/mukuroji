# 0123. Team の近況では Team に付与された Planning の権限を member の操作に使い、Web にもその付与を渡す

- 状態: 提案
- 日付: 2026-11-28
- 関連: PR #773 の CodeRabbit 指摘

## 背景

Team を対象にした近況（health update）の cadence では、確認者を設定するときに Enterprise 認可の `planning.write` を
確認者の Team に対して確かめる。確認者は確認済みをコメントで記録するからである。一方、確認済みのコメントを書くときは
Team の対象に member 以上が要り、`requirePlanningUpdateTeamPermission` は `teams.write` か、Team の Project での member 以上を求める。
そのため、Team に付与された `planning.write` だけを持つ確認者は、設定では受け付けられるのに確認では断られる。

Web では、Planning の操作の可否を Project の役割だけから判定しており、Team に付与された権限（`directTeamGrant`）を知らない。
サーバーが許可する Team の cadence の設定や近況の公開を、Web が押せないボタンとして隠すことがある。

## 決定

- 設定時の判定（確認者に `planning.write`）を正とし、確認時の判定をそれに揃える。`requirePlanningUpdateTeamPermission` は、
  `viewer` のときの `planning.read` と同じく、`member` のときは Team に直接付与された `planning.write` で通す。
  `manager`（cadence の設定）は従来どおり `teams.manage` か Project の manager が要る。
- Team に直接付与されたかの判定は `hasDirectEnterpriseTeamPermission` にまとめ、`requireTeamPermission` と共有する。
- Web 向けの `GET /api/planning` は `viewerTeamGrants`（Team ごとに `manager` か `member`）を返す。`teams.manage` があれば
  `manager`、`teams.write` か `planning.write` があれば `member` とする。Public API の snapshot には含めない。
- Web は、Team だけを対象にした近況の操作（cadence の設定、公開、コメント・確認）で、この付与を Project の役割の代わりに使う。
  Project の対象と、Team の構造の管理には使わない。サーバーの認可は変えず、表示だけを揃える。

## 検討した選択肢

- **確認時の判定を正とし、設定時に `teams.write` か Project の member を求める。** 認可を広げない。ただし設定時に
  別の member の `requireTeamPermission` を再現する必要があり、`planning.write` を Planning の書き込み権限とする Enterprise の
  ロール設計とも合わない。
- **Web の権限を Project の一覧だけから作り続ける。** API の変更が要らない。ただし Team に付与された権限の人には操作が出ない。

## 結果

- Team に付与された `planning.write` を持つ確認者は、設定でも確認でも受け付けられる。
- 近況の担当者（update owner）の設定時の判定（`work-items.write`）と公開時の判定のずれは残る。担当者の判定を
  `planning.write` に揃えると、`project:member` のような Planning の書き込み権限のないロールを担当者にできなくなるため、別に判断する。
- Team に付与された権限で許される Team の近況の操作は、Web にもボタンとして表示される。
