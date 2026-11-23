# 0052. Software factory が off でも本人用 token を発行でき、MCP は Workspace profile で読む

- 状態: 提案
- 日付: 2026-11-22
- 関連: Issue #705, PR #714, [ADR 0029](0029-software-factory-deploy-switch.md)（本人用 token の部分を置き換える）

## 背景

ADR 0029 は、Software factory が off の deploy では本人用 agent token の確認・発行・rotate を `503` で断ることにした。
当時の本人用 token は、coding agent が自分の担当タスクに着手する MCP（`tasks` profile）のためだけにあった。

#705 で、Team を固定せずに Workspace を読む MCP の `workspace` profile を追加した。この profile は Agent Run を
使わず、Public API の Work Item などの読み取りだけを使う。この Public API は off でも残している。それでも off の
deploy で利用者が使える credential は、管理者が作る Workspace の API key だけだった。Workspace の API key は
作成者として動くので、一般メンバーが自分の権限で使う手段がない。

## 決定

- Software factory が off でも、本人用 token の確認（`GET /developer/me/agent-connection`）、発行、rotate を許す。
  Software factory の middleware の一覧から外す。
- 管理者用の `POST /developer/api-keys/:id/rotate` で、対象が本人用 token のときに off で `503` を返す判定も外す。
- 本人用 token の scope、最長 90 日の有効期限、Guest の除外、「メンバーによる agent 用キーの発行」の policy、
  Enterprise permission の判定、audit は変えない。token は持ち主の現在の権限で評価されるので、off で発行しても
  読める範囲は Web と同じである。
- Web の「agent を接続」は off でも表示する。off のときは Team と担当者を固定しない `workspace` profile の設定例を出し、
  タスクの着手や Agent Run の手順は出さない。
- Agent Run、Team の agent 設定、`/v1/agent-context` は引き続き off で `503` を返す。そのため、off で発行した token を
  `tasks` profile に設定しても、タスクの着手はできない。

## 検討した選択肢

- off では管理者の API key だけを使う: 変更はないが、メンバーごとに管理者が key を作って渡す必要があり、key が
  作成者の権限で動くため、メンバー本人の権限で読ませられない。却下。
- off 用に読み取り専用の別種の token を作る: scope を `work-items:read` に絞れるが、#705 の段階 2 で Work Item の
  作成・更新の tool を足すと書き込みも要る。種類を増やす分だけ管理画面と policy が複雑になる。却下。
- remote MCP と OAuth（#707）ができるまで待つ: token 管理は減るが、初回 deploy の後になる。それまで stdio の MCP を
  使えない。却下。remote MCP ができた後も、CI やスクリプトからの利用のために本人用 token は残す。

## 結果

- off の deploy でも、メンバーが自分用 token を発行し、`workspace` profile の MCP で Workspace を読める。
- off で token を発行できるようになる分、管理者が発行を止めたい場合は「メンバーによる agent 用キーの発行」の
  policy で止める。
- ADR 0029 の他の判断（Agent Run と agent 設定を入口で断る、Web の入口を `softwareFactoryEnabled` で出し分ける）は
  変えない。
