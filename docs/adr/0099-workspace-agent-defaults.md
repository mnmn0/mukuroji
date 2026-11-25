# 0099. Workspace の Agent 既定値を AgentRunsTable の Workspace partition に1行で持ち、Team 設定の読み取り時に重ねる

- 状態: 提案
- 日付: 2026-11-25
- 関連: Issue #412、[docs/software-factory.md](../software-factory.md)

## 背景

Agent settings（lease、take over、Ready status、受け入れ条件、brief）は Team ごとにしかなく、
Team を作るたびに同じ値を入れ直す必要があった。Workspace 全体で共通の前提（リポジトリの規則、
テストの流し方など）を agent に渡す手段もなかった。また Project brief は 1 Team で 20 Project までで、
Project の多い Team では足りなかった。

制約は次のとおり。

- Team の Agent settings row は保存済みの schema を変えずに読めること（保存前の row の移行はしない）。
- 既定値の変更は Workspace 管理者だけができ、Team manager の権限では変えられないこと。
- 保存は Team 設定と同じく、revision の CAS と `Idempotency-Key` の receipt で再送を判定すること。

## 決定

- AgentRunsTable の partition `<directoryId>#workspace`、sort key `agent-defaults` に Workspace の既定値を1行で置く。
  値は `leaseMinutes`、`allowTakeoverAfterLeaseExpiry`、`requireAcceptanceCriteria`、任意の `brief`（16 KiB まで）。
  保存ごとの receipt は同じ partition の `agent-defaults-mutation#<key hash>` に、同じ transaction で書く。
  Team partition（`directoryTeamId`）とは別なので、Team の Run や設定の Query に混ざらない。
  agent-run の整合性検査はこの partition を対象外として読み飛ばす。
- Team 設定の読み取り（Web、Public API、MCP の `agent-context`）では、Team row と既定値 row を並行して読み、
  - Team が一度も保存していない（revision 0）ときは、lease、take over、受け入れ条件の必須化を既定値から取る。
  - どの Team にも `workspaceBrief` として既定 brief を返す。agent に渡す brief は、Team brief があればそれ、
    なければ既定 brief とする。
  Team が保存した後は Team の値が優先し、既定値の変更は反映しない。Ready status などの Team 固有の値は既定値に持たない。
- `GET /api/workspace/agent-defaults` と `PUT ...` を追加し、どちらも `workspace.manage` を要求する。
  audit event は `agent-defaults.updated` で、brief は本文ではなく byte 数だけを残す。
- `AGENT_SETTINGS_MAX_PROJECT_BRIEFS` を 20 から 100 に上げる。row の大きさは brief 合計 128 KiB の上限で
  抑えられているため、件数の上限は一覧を見通せる範囲に置く。

## 検討した選択肢

- **Team 作成時に既定値を Team row にコピーする。** 読み取りが1回で済む。ただし既存の Team には効かず、
  既定値を変えても作成済みの Team に届かない。
- **既定値を tenant profile（Workspace 設定の row）に持つ。** Workspace 設定と一緒に読める。ただし Agent settings を
  読む経路はすべて AgentRunsTable を使っており、Software factory を deploy しない環境にも field が増える。
- **Team 設定の field ごとに「既定値を使う」を持つ。** 細かく継承できる。ただし Team の保存 form と
  request の形が変わり、既存の client と Public API の互換を崩す。今回は revision 0 の Team と brief だけを継承する。

## 結果

- Workspace 管理者が、Team が設定を保存する前の lease、take over、受け入れ条件と、共通の brief を一か所で決められる。
- Team 設定の読み取りは既定値 row の GetItem が1回増える。
- 受け入れる欠点は次のとおり。
  - 保存済みの Team には既定値の lease などの変更が届かない。Team の管理者が Team 設定を変えて合わせる。
  - 一括での Run 解放、同時実行数の上限、brief 内の secret 検査、`leaseMinutes` の既定値そのものの変更は、
    今回は作らない。
- 更新した文書は `docs/software-factory.md`、`docs/guide/admin.md`。
