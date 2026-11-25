# 0076. Workspace 単位の月の締めは Team ごとの締め row をまとめて作る

- 状態: 提案
- 日付: 2026-11-23
- 関連: Issue #398、[0020](0020-time-period-close-record.md)

## 背景

工数の月次締めは Team 単位（[0020](0020-time-period-close-record.md)、`TIME_CLOSE#<teamId>#<YYYY-MM>`）で、
Team 全体の manager が Team ごとに締める。経理の締めは会社全体で同じ月に行うので、Team が多いと
全 Team を1つずつ締めることになり、締め忘れも起きる。Issue #398 は Team または Workspace 単位の締めを求めている。

## 決定

Workspace の所有者・管理者とシステム管理者は、`POST /api/time-periods/:month/close` と
`POST /api/time-periods/:month/reopen`（理由必須）で、Workspace の全 Team の同じ月をまとめて締め・解除できる。
`GET /api/time-periods/:month` で Team ごとの状態を読める。

- Workspace 用の新しい row は作らない。Workspace の Project directory にある Team ごとに、既存の Team の締め・解除を
  1 Team ずつ実行する。entry 書き込み時の締め確認（ConditionCheck を含む）、audit event、保存 key は Team 単位のまま変わらない。
- 月と timezone は、どの Team を変える前にも検証する。
- 結果は Team ごとに `closed` / `already-closed` / `reopened` / `not-closed` / `failed` を返す。締め済みの Team はそのまま残し、
  失敗した Team があっても残りの Team は処理する。もう一度実行すると残りだけが変わるので、Idempotency-Key は受けない。
- 権限は Workspace role（owner / admin）かシステム管理者で判定する。Enterprise の割り当てがある利用者は、Workspace role ではなく
  Workspace に付いた `workspace.manage` で判定し、route の権限表でも `/api/time-periods/*` に `workspace.manage` を求める。
  Team ごとの締めの権限（Team 全体の manager）は変えない。
- 各 Team の締め・解除の transaction に、実行者の Workspace membership の ConditionCheck を入れる。途中で権限が変わると、
  残りの Team は書き込まれず `failed` になる。
- 画面は Team の工数画面ではなく Workspace 設定に置く。Team の権限を持たない管理者も締められるようにするため。

## 理由

- Workspace の締め row を足すと、entry 書き込みの締め確認と ConditionCheck を Workspace row にも広げる必要があり、
  IAM と transaction の項目数も増える。Team の row をまとめて作れば、既存の確認がそのまま効く。
- Team ごとに解除できる今の運用（ある Team だけ訂正のため解除する）も、同じ row なのでそのまま使える。

## 影響

- あとで作った Team には Workspace の締めが反映されない。その Team の manager が Team の画面で締める（利用者ガイドに記載）。
- Team の数だけ書き込みと audit event が増える。Workspace の Team 数は数十程度の想定で、1 request 内で順に処理する。
- 全 Team を1つの transaction にしないので、途中で失敗すると一部の Team だけが締まる。結果に `failed` と `partialFailure` を返し、
  再実行で揃える。
