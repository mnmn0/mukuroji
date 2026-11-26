# 0109. Work Item の URL リンクを Planning table の 1 row に置き、Public API と MCP から work-items scope で読み書きする

- 状態: 提案
- 日付: 2026-11-26
- 関連: Issue #705

## 背景

Linear 風 MCP（#705）の `save_attachment` は、pull request やデザインファイルなどの URL を
Work Item に付ける。既存の仕組みはどれも合わない。

- **外部リンク（external links）** は connector の installation を前提にし、同期方向を持つ。
  管理 API と `integrations` の scope が要り、ただの URL を付けるには重い。
- **ファイル添付（attachments）** は file の upload と malware scan を前提にする。
- Work Item row に field を足すと、Work Item の revision が URL の追加ごとに進み、
  ほかの編集が衝突する。Work Item row の schema version も上がる。

## 決定

- Work Item ごとの URL リンクを、Planning table の 1 row
  （`recordKey = WORK_ITEM_WEB_LINKS#{teamId}#{workItemId}`、`entryType = work-item-web-links`、
  `schemaVersion = 1`）に、リンクの配列として置く。1 件の Work Item に最大 50 件。
- 書き込みは row の revision の compare-and-set と、次の ConditionCheck と監査 event を 1 つの
  TransactWrite にまとめる。
  - 読んだときの Work Item revision（Project の移動や削除のあとに書かれない）
  - 呼び出した人の member row と、enterprise role の source（権限を失ったあとに書かれない）
  - Public API の idempotency receipt（応答を失った retry が二重に足さない）
  競合したら読み直して 3 回まで試す。
- row に Work Item の作成時刻を持つ。同じ ID で作り直された Work Item には、前の Work Item の
  リンクを見せない。削除された Work Item の row は残るが、読まれない。
- URL は contracts の `parseWorkItemWebLinkUrl` で正規化し、`http` と `https` だけ、ユーザー名と
  パスワードなし、2048 文字までにする。同じ URL は 1 回だけ付けられる。タイトルは 256 文字まで。
- 監査 event は `work-item.web-link-added` と `work-item.web-link-removed`。リンク ID と URL の
  host だけを残し、URL 全体とタイトルは残さない。path や query に共有 token が入ることがあるため。
- 読むには Work Item の viewer、付け外しには member と業務の書き込みロールが要る。Public API は
  既存の `work-items:read` と `work-items:write` で受ける。
  - `GET/POST /api/v1/work-items/{workItemId}/web-links`
  - `DELETE /api/v1/work-items/{workItemId}/web-links/{linkId}`
  Web には同じ判定の `/api/teams/{teamId}/issues/{issueId}/web-links` を置く。
- MCP は `list_attachments`、`save_attachment`、`delete_attachment` を Workspace profile に足す。

## 検討した選択肢

- **外部リンクに provider `web` を足す。** 一覧と表示は使い回せる。ただし connector の installation と
  `integrations` scope が前提で、同期方向など URL には意味のない field を持つことになる。
- **リンク 1 件を 1 row にする。** 件数の上限がなくなる。ただし上限と URL の重複を守るには
  別の counter row か一覧の読み直しが要り、1 件の Work Item で 50 件を超える使い方は想定していない。
- **新しい table を作る。** 分離はきれいだが、CDK・IAM・backup の設定が増える。Planning table は
  Project の schedule baseline など Work Item に付く小さな row を既に持つ。

## 結果

- リンクの追加と削除は Work Item の revision を進めず、ほかの編集と衝突しない。
- 1 件の Work Item のリンクの書き込みは、row の revision で順番に並ぶ。
- 50 件を超える必要が出たら、1 件 1 row の形に移す。その場合は data migration を用意する。
- Web から付けたリンクの重複送信は、URL の重複として 409 になる。Web route は idempotency receipt を
  持たない。
