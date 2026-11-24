# 0070. Planning を Team / Project / Portfolio 単位で読み、key 設計は変えずに link と Work Item だけを絞る

- 状態: 提案
- 日付: 2026-11-23
- 関連: Issue #641、Issue #369、ADR 0012、[docs/planning.md](../planning.md)「単位ごとの読み取り」

## 背景

Planning は Workspace 全体の live graph（最大 20,000 row）と、読める Work Item 全体を毎回読んで 1 つの
snapshot を作っていた。1 Project の画面（Project 概要）でも Workspace 全体を読むため、Project が増えるほど
読み取りの量と時間が増える。

live graph の row の大半は Work Item link（Work Item ごとに 1 row）で、entity・entity dependency・
update target は人が作る分だけで少ない。また entity の親子は「子の scope は親の scope 以下」に制約されて
いるため、ある Project の entity の祖先は Workspace scope・その Team scope・その Project scope のどれかに
ある。

初回 deploy（11/25 予定）を控えており、key 設計の変更や data migration は避けたい。

## 決定

- `GET /api/planning` に `teamId`、`teamId` + `projectId`、`portfolioId` の query を足し、指定時は
  その単位だけの snapshot（`readScope` 付き）を返す。指定なしは従来どおり Workspace 全体。
- DynamoDB の key は変えない。単位ごとの読み取りでは:
  - `ENTITY#`・`DEPENDENCY#`・`WORK_ITEM_DEPENDENCY#`・`UPDATE_TARGET#` は従来どおり全体を強整合で読む
    （階層の検証と祖先の解決に要る。量は人が作る分に限られる）
  - Work Item link は、Team では `LINK#<teamId>#` の prefix Query、Project ではその Project の Work Item
    の key だけを `BatchGetItem`（ConsistentRead）で読む。Workspace scope の Portfolio は配下が Team を
    またぐので全体を読む
  - Work Item は、その単位の Team / Project だけを読む（既存の read scope を使う）
  - 前後の META 強整合 read で revision を挟む契約はそのまま
- snapshot の `capacity` は Workspace 全体の量のままにする。単位ごとの読み取りでは全 row を数えられない
  ので、Planning の commit が測った row 数と byte 数を META（`liveRowCount` / `liveByteCount`）に書き、
  それを返す。META に値がない（旧 row、または Planning 以外の writer が META を置き換えた）場合と、
  Lambda の graph cache が当たる場合は、全体を読んで数える。
- 範囲外の entity・link 参照・dependency は snapshot に含めず、critical path と roll-up は範囲内で算出する。
  範囲は `docs/planning.md` に定義する。
- API の role に Planning table の `dynamodb:BatchGetItem` を足す。

## 検討した選択肢

- record key に scope を入れる（`ENTITY#P#<team>#<project>#<id>` など）: entity も scope で絞れるが、
  entity ID だけで row を引く通知・Cycle schedule の index と既存 row の key が変わり、key を変える
  migration が要る（現在の migration runner は key を変えない）。初回 deploy 前の変更として大きすぎる。
- scope ごとの index row（pointer row）を足す: transaction の item 数が増え、Archive の step budget と
  容量の数え方に影響する。
- GSI で scope を引く: GSI は強整合で読めず、snapshot の revision と内容の一致を保てない。
- link を Work Item key で引く（採用）: key も migration も変えず、増える row（link）だけを絞れる。

## 結果

- 20,000 row 近い Workspace でも、Project 概要は Workspace 全体の link と Work Item を読まずに表示できる。
  Project 概要は blocker の状態に同じ Team の別 Project の Work Item が要るため、Team 単位の読み取りを使う。
- entity が数千件ある Workspace では、単位ごとの読み取りでも entity row は全体を読む。entity 側を絞る
  必要が出たら、scope を key に入れる変更を ADR と migration 付きで行う。
- 単位ごとの読み取りの `capacity` は直近の Planning commit 時点の値で、通知 schedule worker が
  `UPDATE_TARGET#` の due index 属性を書いた分の byte 差は次の commit まで反映されない。
- Planning 画面（timeline / roadmap / portfolio）は従来どおり Workspace 全体の snapshot を読む。
