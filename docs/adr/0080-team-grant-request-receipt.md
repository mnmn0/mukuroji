# 0080. Team 全体へのメンバー追加の冪等キーを、Project Directory table の sidecar 受付行で入力に結び付ける

- 状態: 提案
- 日付: 2026-11-23
- 関連: Issue #384, PR #752

## 背景

チームの設定から、1人のメンバーを Team のすべての有効な Project に追加できるようにした（#384）。
この操作は Project ごとに別の transaction で所属行を書く。途中で失敗しても、同じ `Idempotency-Key` で
再送すれば残りの Project だけを追加できる。

一方で、同じキーで別の入力（別の Team、メンバー、ロール）を送った場合は、`server/AGENTS.md` の規則に
従って conflict にする必要がある。監査 event は Project ごとに識別子を派生させるため、監査の冪等性では
この再利用を検出できない。最初は所属行にキーを記録して後から照合したが、この方法には次の抜けがあった。

- 同時に届いた2つのリクエストが、どちらも書き込み前の照合を通る。
- 書き込む所属行がないとき（全 Project に所属済み、または有効な Project がない）は、キーが残らない。
- 所属行のロール変更や削除で、記録したキーが消える。

## 決定

- 付与を始める前に、Project Directory table に受付行を条件付きで書く。
  - partition key `directoryId` は `TEAM_GRANT_REQUEST#<encodeURIComponent(workspaceId)>`、
    sort key `entryKey` は `KEY#<idempotencyKeyHash>` にする。
  - 属性は `entryType: 'team-grant-request'`、`workspaceId`、`requestFingerprint`、`createdAt`。
  - 条件は `attribute_not_exists(entryKey) OR requestFingerprint = :requestFingerprint`。
    条件に失敗したら `409 IdempotencyKeyConflict` を返し、どの Project にも書かない。
- `idempotencyKeyHash` は Workspace・操作者・キーから作る既存の値を使う。そのため、別の利用者のキーとは衝突しない。
- 受付行は Workspace の directory partition の外に置き、Project Directory の読み取りに影響させない。
- テナント削除では、既存の sidecar と同じように Workspace ごとの partition を削除対象に加える。
  既存の job の index を変えないよう、対象の一覧の末尾に置く。
- データ整合性検査では、既知の補助行に加え、partition と sort key の形を検証する。

## 検討した選択肢

- 選択肢 A（採用）: request 単位の受付行を条件付きで書く。
  - 利点: 同時実行でも、書き込みが必要ない場合でも、キーと入力の結び付きが1回の条件付き書き込みで決まる。
  - 欠点: 新しい sidecar partition が増え、テナント削除と整合性検査に登録が必要になる。
- 選択肢 B: 所属行にキーを記録して照合する。
  - 利点: 行が増えない。
  - 欠点: 背景に書いた3つの抜けがある。
- 選択肢 C: 監査 event の冪等性に任せる。
  - 利点: 新しい保存がない。
  - 欠点: Project ごとに識別子を派生させるため、別の入力の再送を検出できない。

## 結果

- 同じキーで別の入力の Team 全体への追加は、タイミングや既存の所属にかかわらず 409 になる。
- 同じ入力の再送は受付行の条件を満たすので、残りの Project の追加を続けられる。
- 受付行には TTL がなく、Workspace を削除するまで残る。1回の Team 全体への追加ごとに1行だけ増える。
