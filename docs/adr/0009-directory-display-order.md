# 0009. Team と Project の表示順を sort key から切り離し、名称変更で ID を変えない

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
  読んだ名前（と色）がまだ保存されていることを条件にし、遅れた名称変更が新しい変更を上書きしないようにする。
  Team row には名称変更の回数 `nameRevision`（任意の整数）を持たせ、Team の検索 document の
  `sourceRevision` に使う。遅れて届いた古い名前の投影が、新しい名前の document を置き換えない。
- 復元は `archivedAt` を消す。アーカイブ中も Project member、Work Item、Planning の
  参照は残っているので、復元すると元に戻る。Project の復元は Team が有効なことを条件にする。
  アーカイブで一緒にアーカイブされた Planning の更新対象も、同じ transaction で使える状態に戻し
  （Planning の revision を上げる）、cadence は消す。
  アーカイブで始まった Webhook grant の後始末（cleanup locator）が残っている間は、復元を 409 で断る。
  後始末より先に復元すると古い grant が有効に戻り、復元後に作り直した grant を後始末が消してしまうため。
- Project row にも名称変更・色変更の回数 `nameRevision` を持たせ、Project の検索 document の
  `sourceRevision` は charter の revision と `nameRevision` の和にする。どちらも増えるだけなので、
  同じ row を 1 回読んだ値どうしなら、新しい方が必ず大きい。
- 新しい Team / Project の row には作成者 `creatorUserId` を記録し、名称変更・復元で検索 document を
  作り直すときも作成者を保つ。記録のない既存の row は、保存済みの document の作成者を残す。
- Team / Project row にアーカイブと復元の回数 `lifecycleRevision` を持たせ、検索 document の
  `sourceRevision` に足す（Team は `nameRevision` との和、Project は charter の revision・`nameRevision`
  との和）。検索 document は名称変更・charter 更新・アーカイブ・復元のたびに row を strongly consistent
  read で読み直して合わせる。有効な row は投影したあとにもう一度読み、アーカイブされていたら削除する。
  削除はその時点の `sourceRevision` 以下の document だけを消すので、遅れて届いた古い投影がアーカイブ後に
  document を作り直すことも、遅れた削除が後の復元で作り直した document を消すこともない。
  検索の backfill も同じ revision で put と削除を fence する。
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
- 復元は Team・audit・Planning revision・更新対象に加えて呼び出し元の権限確認（最大 2 件）も同じ
  transaction に入れる。アーカイブできた Team を必ず復元できるよう、Team のアーカイブで一緒に
  アーカイブできる Project の更新対象は 95 件までにした（以前は 97 件）。
- アーカイブ時に止めた Planning の更新スケジュール（cadence）と Webhook の Team / Project grant は、
  復元しても自動では戻らない。更新対象は使える状態に戻るので、cadence は設定し直せる。
- 利用者ガイドは `docs/guide/admin.md` を更新した。
