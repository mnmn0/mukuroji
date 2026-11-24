# 0047. 工数の作業区分を Workspace の tenant profile で定義し、区分は消さずに使用停止にする

- 状態: 提案
- 日付: 2026-11-22
- 関連: Issue #397、Issue #630、ADR 0030、ADR 0035

## 背景

#571 で工数 entry に作業区分 `category` を入れたが、区分は `contracts` の固定リスト
（設計・実装・レビュー・会議・管理・教育・休暇）だった。#397 は、区分を Workspace で定義し、
entry と集計の grouping に使うことを求めている。会社ごとに「営業支援」「社内研修」のような区分が要り、
既定の名前も社内の呼び方に合わせたい。

区分の key は工数 entry と提出済みの週報（ADR 0030 の `indirectTime`）に保存される。
区分を消すと、それを使った記録の名前が分からなくなる。

## 決定

- 区分は Workspace の設定とし、tenant profile に `timeEntryCategories: { categories: { key, label?, active }[] }`
  として保存する。並びが表示順。変更は既存の `PATCH /api/tenant/profile`（Workspace 管理の権限と
  `expectedRevision` の比較、監査 event `tenant.profile.updated`）で行う。保存していない Workspace は既定の 7 区分。
- 検証は `contracts` の `readWorkspaceTimeEntryCategorySettings` が持つ。key は小文字英字で始まる英小文字・数字・`-` の
  40 文字以内で、集計の予約 key（`uncategorized`・`no-work-item`）は使えない。1〜50 区分、key の重複なし、
  1 つ以上が `active`。既定の key の `label` は任意（なければ Web が翻訳した名前を出す）、それ以外は 1〜60 文字の `label` が必須。
  Web は日本語の名前から key を作れないので、追加する区分の key は `custom-<乱数>` にする。
- 区分は消さずに `active: false` で使用停止にする。保存済み（未保存なら既定）の key を落とす変更は
  `400 TimeEntryCategoryRemoved` で拒否する。名前を変えても key は変わらないので、過去の entry と週報も新しい名前で読める。
- 全メンバーが区分を読めるよう、認証だけの `GET /api/workspace/time-entry-categories` を足す
  （`GET /api/workspace/calendar-settings` と同じ扱い）。
- 工数の作成では区分が `active` であることを確かめ、なければ `400 InvalidTimeEntryCategory`。
  更新では区分を変えたときだけ確かめ、使用停止後も同じ区分のままなら編集できる。
  工数の service は tenant profile を GetItem する読み取り port（`TimeTrackingCategorySource`）を受け取る。
- 保存済みの entry と週報は key の形だけを確かめ、Workspace の一覧にあるかは見ない（一覧から外れた key も読める）。
  週報の `indirectTime` の区分も同じく形だけを確かめ、件数の上限は 50 にする。
- 集計の `groupBy=category` と CSV の label には Workspace が付けた名前を入れる。名前のない既定の区分は key のまま
  （Web が翻訳する）。

## 検討した選択肢

- 区分を独立した行（`TIME_ENTRY_CATEGORY#<key>`）で持つ: 1 区分ずつ更新でき件数の制約が緩いが、並び順と
  「1 つ以上 active」の検証に複数行の transaction が要り、管理画面の保存も別になる。50 区分なら profile に収まる。
- Team ごとに区分を持つ: 柔軟だが、Team を跨ぐ集計で同じ key が別の意味になり、週報の読み手も Team ごとの一覧が要る。
  #397 の文言どおり Workspace で持つ。
- 区分の削除を許し、使っていない区分だけ消せるようにする: 使用有無の確認に工数と週報の全件走査が要る。使用停止で足りる。
- 週報の提出時にも区分が一覧にあるか確かめる: 週報は下書き作成時の工数から作るので、提出までに使用停止された区分で
  弾かれてしまう。週報の区分は記録の要約なので形だけでよい。

## 結果

- 新しい table・index・queue はない。API の工数の作成・更新・集計で tenant profile の GetItem が 1 回増える
  （区分つきの作成・区分を変える更新・区分別の集計のときだけ）。
- 一覧から外れた key（形は正しい）を持つ週報は、Web では key をそのまま表示する。
- 管理者が名前を変えると、過去の集計・週報の表示名も変わる（名前の履歴は持たない）。
- 更新した文書: `docs/guide/admin.md`、`docs/guide/member.md`。
