# 0073. Team を health update の対象にし、確認者の「確認済み」を update version ごとの marker 付きコメントで記録する

- 状態: 提案
- 日付: 2026-11-23
- 関連: Issue #402、Issue #241、Issue #343、ADR 0069

## 背景

Issue #402 では、Project / Initiative に加えて課やグループの単位（Team）でも週次の health update を
提出し、上長が「確認済み」を記録できるようにする。完了条件は、Team の週次 update を提出でき期限管理が
Project と同じに動くこと、確認すると作成者に通知され一覧に「確認済み」が出ること、設定のない Workspace
はこれまでどおり動くこと。

これまでの状態は次のとおり。

- update target は `project`（Team + Project）と `initiative`（Planning entity）の 2 種類で、
  `UPDATE_TARGET#` row の cadence が期限・リマインダー・エスカレーションを持つ。通知 schedule worker、
  Update Feed、Focus、Inbox の通知投影は target の種類ごとに scope と record key を検証し直す。
- 確認は Web だけの表示で、cadence の `escalationMemberKey` が付けた ✅ リアクションを「確認済み」と
  見なしていた。サーバーは誰が付けたかを区別せず、通知も Focus も確認状態を知らなかった。
- 本番環境はまだ deploy していない（Issue #636）ので、保存済みの ✅ リアクションの移行は考えなくてよい。

## 決定

- Update target に `{ type: 'team', teamId }` を加える。record key は `UPDATE_TARGET#TEAM#<teamId>`、
  公開 key は `team/<teamId>`、通知の entity は `planning-update` のまま。
- Team target の認可は Team scope の Initiative と同じにし、Project と同じ権限段階を Team の
  role に当てはめる。読み取りは viewer、コメントと確認は member、公開は更新担当者の member か
  manager、cadence の変更は manager。Enterprise 認可では Team を resource にする。
  根拠・進捗に使う範囲（visibility envelope）は `{ teamId }` で、Project を持たない Team 直下の
  Work Item と計画だけを含む。Project の内容は Project の権限で別に見るので、Team の update には
  入れない。
- Cadence に `reviewerMemberKey`（確認者）を加える。省略時は `escalationMemberKey` が確認者を兼ね、
  これまでの Workspace の挙動を保つ。保存時には確認者が対象の member 権限を持つことを確かめる。
- 「確認済み」は `acknowledgement: true` 付きの update コメントとして記録し、同じ transaction で
  `UPDATE_ACK#<target>#<16 桁の version>` row を存在しない条件付きで書く。version ごとに 1 回だけ
  記録でき、2 回目は `409 PlanningUpdateAlreadyAcknowledged`。確認者でない member は
  `403 PlanningUpdateAcknowledgementForbidden`。確認者の判定は認可に使った snapshot の cadence で行い、
  既存の annotation と同じく Planning `META` の revision を条件にするので、cadence の変更と競合した
  記録は commit しない。
- 履歴 API は version ごとに `acknowledgement`（確認者・コメント ID・時刻）を返す。target ごとの
  activity projection（`UPDATE_ACTIVITY#`）が最新 version の最初の確認を持ち、Update Feed の
  「確認済み」と Focus の確認待ちに使う。
- 通知は既存の audit outbox を使う。公開時に確認者を候補（reason `update-reviewer`、エスカレーション先と
  同じ member なら重複させない）に加え、確認のコメントは作成者を候補（reason `update-author`）にして
  「Acknowledged: …」の件名にする。
- 確認者の Focus に、自分以外が公開した最新 version のうち未確認のものを「確認待ちの進捗報告」として出す。
- Portfolio は update target にしない。Portfolio の状況は配下の Project / Initiative の update を
  集計して見る（ADR 0069 のポートフォリオ snapshot）ので、Portfolio 単位で別の報告と期限を持つと
  同じ内容を二重に書くことになる。Issue #402 にこの理由を残す。

## 検討した選択肢

- ✅ リアクションのまま確認を表す: 既存の API で済むが、サーバーが確認者を区別できず、通知・Focus・
  Feed が確認状態を使えない。誰でも同じ絵文字を付けられるので記録として弱い。
- 専用の acknowledgement API と row だけを持つ: 確認時の所見をコメントと別に書く必要があり、
  画面と通知の経路が増える。コメントに印を付ける方が既存の idempotency・認可・activity をそのまま使える。
- Team target を Team 配下の Project の内容まで含めて集計する: Team の member 権限だけで Project の
  内容が見えてしまう。Project を含む集計は ADR 0069 の snapshot が Project の権限で行う。
- Portfolio も update target にする: 上記の二重入力に加え、Portfolio entity の権限と期限の扱いを
  新たに決める必要がある。

## 結果

- Team の週次 update が Project と同じ cadence・通知・Feed・Focus の仕組みで動く。
- 確認は version ごとに 1 回で、確認者・時刻・所見が残り、作成者に通知が届く。
- 確認者を変えても、過去の version の確認は記録した member のまま表示する。未確認の version は新しい
  確認者を待つ。
- `UPDATE_ACK#` は annotation と同じく graph の読み取りで飛ばす。追加の table・index・IAM はない。
- Workspace ごとの update テンプレートと必須項目は Issue #402 の別の PR で扱う。
- 更新した文書: `docs/planning.md`、`docs/guide/pm.md`。
