# 0026. 子の復元を親ごとの guard row で数え、親の archive を固定数の項目で fence する

- 状態: 提案
- 日付: 2026-11-20
- 関連: Issue #633, PR #648

## 背景

#633 で、archive されていない子が残る親の archive と、archive 済みの親の下の子の復元を拒否することにした。
確認は子（または親）を読んでから archive・復元の transaction を書くので、その間に子が復元されると
archive 済みの親の下に未 archive の子が残る。

最初は読んだ子それぞれの revision を transaction に ConditionCheck として入れた。DynamoDB の transaction は
100 項目までで、更新本体・event・audit・認可・Agent Run の fence も入るため、子の数に上限が要る。
Bulk 操作も 100 item までなので、子が約 160 件を超える親は、子をすべて archive した後でもどの組み合わせでも
archive できなくなった。

## 決定

`WorkItemConfigurationTable` の Team scope に、親ごとの `CHILD_RESTORE#<encoded-parentWorkItemId>` row
（`entryType=child-restore-guard`、`schemaVersion=1`、単調増加の `generation`）を置く。

- 子を復元する transaction は、親の revision の ConditionCheck に加えて、親の guard row の `generation` を
  読んで検証した値を条件に 1 進める。row が無ければ作る。
- 親を archive する transaction は、子を読む前に guard row を強整合で読み、その `generation`
  （row が無ければ `attribute_not_exists`）と relation graph の revision を ConditionCheck する。
- 読んだ子ごとの revision は fence しない。子の数による上限（`WorkItemTooManyChildren`）は設けない。

## 検討した選択肢

- 子ごとの revision を fence する: 追加の row は要らない。子の数が transaction の上限に縛られ、大きな親を
  archive できない。
- 子の復元で relation graph の revision を進める: 既存の row だけで済む。relation とは関係のない復元が Team 全体の
  relation 変更や schedule preview の確定を競合させる。
- 子の復元で親の Work Item row を更新する: 親の revision が進み、親の編集が無関係に 409 になる。Work Items table の
  stream から realtime や projection にも流れる。
- 親ごとの guard row（採用）: 競合するのは同じ親の子の復元と親の archive だけで、項目数は子の数によらず一定。
  row が 1 種類増える。

## 結果

子が何件あっても、子をすべて archive した親を単独で archive できる。復元の transaction は 1 項目増える。
guard row は親の Work Item を削除しても残る（数 byte で、読むのは同じ親の archive だけ）。
`docs/work-item-configuration.md`（key 一覧と guard row）、`docs/work-items.md`（archive・復元と階層）を更新した。
