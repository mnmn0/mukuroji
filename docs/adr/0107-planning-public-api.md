# 0107. Planning の Public API は `work-items:read` / `work-items:write` で受け、権限判定は Web の `planning.read` / `planning.write` と同じにする

- 状態: 提案
- 日付: 2026-11-26
- 関連: Issue #706, #705, ADR 0012, ADR 0025

## 背景

Workspace profile の MCP（Linear の MCP に近い汎用 MCP）の段階 3 として、Milestone・Cycle・健康度の更新（status update）を
agent から読み書きしたい。これまで Planning は Web 向けの `/api/planning` だけで扱い、Cognito の session と
Workspace の permission `planning.read` / `planning.write` で認可していた。Public API には Planning の endpoint がなかった。

Public API の credential（API キー・本人用 token・OAuth app）が持てる scope は OpenAPI の契約で固定されており、新しい
scope を足すと発行済みの本人用 token では使えず、互換性検査も通らない。本人用 token は `work-items:read` /
`work-items:write` に限られている。

Planning の graph は Workspace 全体で 1 つの revision を持ち（ADR 0012）、Web は書き込みのたびに読み込んだ revision を
`expectedRevision` で送る。agent は読み込みと書き込みの間に他の変更が入りやすい。

## 決定

- `/api/v1/planning/entities`（GET）、`/api/v1/planning/milestones`（POST）、`/api/v1/planning/milestones/{id}`（PATCH）、
  `/api/v1/work-items/{id}/planning`（GET / PUT）、`/api/v1/planning/status-updates`（GET / POST）を追加する。
- 読み取りは `work-items:read`、書き込みは `work-items:write` で受ける。Planning 専用の scope は作らない。
- credential の持ち主を Web と同じ principal に解決し、Web の `/api/planning` と同じ use case で `planning.read` /
  `planning.write` と entity・Project ごとの権限を判定する。Web が読む旧形式の Project scope も同じく効かせ、
  Team scope の entity の見え方を Web とそろえる。Web の route handler は同じ use case を呼ぶ形に整理し、挙動は変えない。
- Public API で作成・変更できる entity は Milestone だけにする。ほかの type は一覧だけを返す。
- `expectedRevision` は任意にする。省略すると server が最新の revision で書く。送ったときは Web と同じく、Planning
  自体が変わっていれば `409` にし、Work Item の変更で進んだだけの revision は受け入れる。
- 書き込みはすべて `Idempotency-Key` を要求する。Milestone と status update の ID は key から決定的に作り、応答が失われた
  後の同じ key の再試行は、作り済みの entity・update を返す（revision が進んでいても `409` にしない）。

## 検討した選択肢

- 選択肢 A: `planning:read` / `planning:write` の scope を新設する。利点: 権限を細かく渡せる / 欠点: 発行済みの本人用 token と
  OAuth app が使えず、契約の scope の列挙を広げる互換性の問題が出る。
- 選択肢 B: Work Item の scope で受け、権限は Web と同じ判定に任せる（採用）。利点: 今の token のまま使え、見える範囲が
  Web と一致する / 欠点: Work Item だけを渡したい token でも Planning を書ける（Web で書ける範囲に限る）。
- 選択肢 C: `expectedRevision` を必須にする。利点: 競合を必ず検出する / 欠点: Workspace 全体の revision は他人の Planning
  変更でも進むため、agent の書き込みがほぼ毎回競合する。

## 結果

- agent は Web で扱える範囲の Milestone・Cycle・健康度の更新を、今の本人用 token のまま読み書きできる。
- Milestone 以外の entity の作成・変更、status update の編集・削除は Public API からできない。必要になったら endpoint を足す。
- `expectedRevision` を省いた書き込みは、直前の他人の変更を上書きし得る。Milestone の更新は渡した項目だけを変えるため、
  影響は同じ項目の同時変更に限られる。
- 更新した文書: `docs/public-api.md`、`docs/coding-agent-mcp.md`、`docs/guide/coding-agent.md`、`CHANGELOG.md`。
