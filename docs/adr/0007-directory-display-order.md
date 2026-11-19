# 0007. Team と Project の表示順を sort key から切り離し、名称変更で ID を変えない

- 状態: 提案
- 日付: 2026-11-19
- 関連: Issue #384

## 背景

Team と Project の directory row は、`entryKey`（sort key）に作成時の順番を埋め込んでいる
（`{teamSortOrder}#{projectSortOrder}#PROJECT#{projectId}`）。サイドバーの並びは query が返す
sort key の順そのものだったので、並び替えるには row の key を作り直す必要があった。
key を変えると、key を前提にした transaction の条件、data integrity の検査
（`entryKey` と `teamSortOrder` の一致を確かめる）、Webhook の権限 index がすべて影響を受ける。

また、Team / Project の ID は作成時の表示名から作るので、名称変更で ID も変えるのかを決める必要があった。

## 決定

- 表示順は row の属性 `displayOrder`（任意の整数）で持つ。`displayOrder` がない row は従来どおり
  `teamSortOrder` / `projectSortOrder` を使う。sort key と `teamSortOrder` / `projectSortOrder` は
  作成後に変えない。
- 並び替えは「有効な Team 全部」または「1 Team の有効な Project 全部」の ID 一覧を受け取り、
  その row が今持っている表示位置の集合を新しい順に割り当て直す。位置が変わる row だけを、
  有効であることを条件に 1 transaction で更新する。一覧が現在の有効な row と一致しないときは
  409 を返す。
- 名称変更は `nameJa` / `nameEn`（Project は `tone` も）だけを更新し、ID・sort key・URL は変えない。
- 復元は `archivedAt` を消すだけにする。アーカイブ中も Project member、Work Item、Planning の
  参照は残っているので、復元すると元に戻る。Project の復元は Team が有効なことを条件にする。
- 変更はすべて `project.renamed` / `project.restored` / `project.reordered` として audit に記録する。

## 検討した選択肢

- 並び替えのたびに sort key を作り直す: 既存の順序の仕組みのままで済むが、row の削除と作成が
  必要になり、key に依存する条件・integrity 検査・権限 index をすべて書き換えることになる。
- 表示順を別の preference row にまとめて持つ: row 数が増えず 1 回の Put で済むが、Team / Project の
  作成・アーカイブと順序 row の整合を別に保つ必要がある。
- 名称変更で ID も作り直す: ID が常に表示名と一致するが、URL・Work Item・Planning link・
  Webhook grant をすべて移す必要があり、Issue の完了条件（ID・URL・既存の link が壊れない）を満たせない。

## 結果

- 並び替えは既存の key や検査を変えずに、属性の更新だけでできる。
- 新しい Team / Project は作成時の位置（既存の最大値 + 10）を使い、並び替えはその範囲内の位置を
  割り当て直すだけなので、あとから作った row は末尾に並ぶ。
- 位置を割り当て直す前提として、1 回の並び替えで扱える row は transaction の上限から 90 件までとする。
- アーカイブ時に止めた Planning の更新スケジュールと Webhook の Team / Project grant は、復元しても
  自動では戻らない。必要になったら別に扱う。
- 利用者ガイドは `docs/guide/admin.md` を更新した。
