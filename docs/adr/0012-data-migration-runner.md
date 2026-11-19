# 0012. 保存済み row の schema 移行を、checkpoint 付きの共通 runner と専用の checkpoint table で行う

- 状態: 提案
- 日付: 2026-11-20
- 関連: Issue #365、[docs/data-migration.md](../data-migration.md)

## 背景

これまでは schema を変えた環境の開発 data を消して作り直していた（[docs/work-items.md](../work-items.md)「運用」）。
社内で実 data を運用し始めると、この運用は成り立たない。#335・#337・#340 などは保存済み row の schema を
変えるため、本番 data を残したまま、途中で失敗しても再開できる移行の仕組みが要る。

制約は次のとおり。

- 常時の固定費を増やさない。
- strict reader の fail-closed（未知の version を読まない）を弱めない。
- 同じ page を 2 回処理しても結果が変わらない（再実行が安全）。
- 1 回の実行の読み書きの量に上限を付ける。

## 決定

- 新しい server module `data-migration` に、migration 定義の契約、runner、verifier、DynamoDB adapter を置く。
  migration 定義は 1 entity の version `N` → `N + 1` だけを扱い、`classify` と `transform` の純粋関数で表す。
- row は conditional put で置き換える。条件は「stored version が `N`」で、writer を止めない migration では
  さらに「revision が読んだ値のまま」を条件にする。migration は revision を進めない。
- table は parallel scan の segment に分け、segment を checkpoint の単位にする。
- checkpoint は専用の DynamoDB table（partition key `migrationId`、sort key `partitionId`、on-demand）に置き、
  revision の compare-and-set と 5 分の lease で同時実行を防ぐ。
- checkpoint は物理 table 名を持ち、別の table で再開しようとすると拒否する。
- 書き込む実行は、最初の書き込みの前に実行者（STS の caller ARN）と対象 table を run record として同じ table の
  別 partition（`RUN#<id>`）に保存する。Workspace 単位の監査 event には載せない（table 全体の操作で、
  特定の Workspace の操作ではないため）。
- 最初の実行経路は operator 向けの CLI（`bun run data:migrate`）とし、`--apply` を付けない限り dry run にする。
- runner は version を上げる向きにしか動かさない。rollback は dual-read の code を保つことで行い、旧 version しか
  読めない code に戻す手段は PITR restore だけとする。
- 読み取り API は dual-read の deploy（旧 version と新 version の両方を読む）で migration 中も止めない。
  dual-read の期間は `verify` が `pass` になった後の deploy で終える。

## 検討した選択肢

- 選択肢 A（採用）: 専用の checkpoint table。
  利点: 業務 table に補助 row を足さないので、strict reader や integrity checker の分類を変えずに済む。
  migration の後始末も table ごと消せる。on-demand なので使わない間の費用はほぼない。
  欠点: table が 1 つ増え、CDK と IAM の定義が要る（この PR では local の自動作成だけで、CDK は後続）。
- 選択肢 B: 対象 table に `MIGRATION#` の補助 row を置く。利点: table が増えない。
  欠点: 各 table の strict reader、integrity checker、search backfill が未知の row として fail-closed になるか、
  全員に除外規則を足す必要がある。
- 選択肢 C: checkpoint を operator の手元の file に置く。利点: AWS resource が要らない。
  欠点: 別の operator や Lambda から再開できず、同時実行も防げない。
- partition の分け方: Team / Workspace の partition key で Query する案もあるが、table ごとに key 設計が違い、
  partition の一覧を別に持つ必要がある。scan segment は key 設計に依存せず全 table に使えるため先に採る。
  Team / Workspace 単位の Query は、必要な migration が出たときに row store を足す。

## 結果

- schema version を上げる PR は、migration 定義と dual-read の reader を同じ PR に入れ、dry run・`--apply`・
  `verify` で移行できる。
- 途中で止めても、同じ command で最後に保存した page の続きから再開できる。
- scan segment は対象 table 全体を読むため、費用は table の総行数に比例する。対象 entity が table の
  一部だけの場合も全 row を読む。
- AWS 上の checkpoint table、Lambda からの実行、rehearsal と CI smoke は後続の変更で足す。
- 更新した文書: `docs/data-migration.md`、`docs/operational-readiness.md`、`docs/architecture.md`。
