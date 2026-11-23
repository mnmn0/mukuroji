# 0072. Project の進捗レポートを snapshot として保存し、token 付きの read-only リンクで社外に共有する

- 状態: 提案
- 日付: 2026-11-23
- 関連: Issue #349

## 背景

Project の進捗（健康状態、遅れている Milestone、進捗、未解決のリスク、次のアクション）を社外の
ステークホルダーに渡すには、これまで画面を写すかドキュメントに書き写すしかなかった。
Issue #349 は、レポートを PDF / Markdown / PPTX で出力し、期限付きで取り消せる read-only のリンクで
サインインなしに見せることを求めている。リンクは作成者が範囲を選び、閲覧は記録し、Workspace の閉鎖で無効になる。

## 決定

### レポートは作成時点の snapshot

- レポート（`ProjectStatusReport`、`contracts/src/project-status-reports.ts`）は、作成者が読める Project overview の
  データから web が組み立てる。各 section は最大 50 行、全体は 96KB までとする。
- 共有リンクを作ると、server は契約どおりの形・大きさかを厳密に検証し、共有範囲（section の選択、担当者名を出すか）で
  伏せたあとの snapshot を share row に保存する。公開側は保存した snapshot だけを返し、Project・Work Item・
  工数などの生データを読まない。このため、外したセクション、他の Project の情報、原価は公開側から辿れない。
- 次のアクションは、読めなかった・読み取り対象外のドキュメントがあるとき `incomplete` を付け、出力に
  「ほかにも未完了の項目があるかもしれません」と書く。読めなかったことを「なし」に見せない。
- レポートの元になる読み込み（Planning・Work Item・RAID log・ドキュメントと宿題）が再試行で直りうる理由で
  失敗したときは、web はレポートを作らず、出力と共有を止めて再読み込みを促す。section が黙って欠けた
  snapshot を出さないため。403（読む権限がない）と Work Item の件数上限は再試行で変わらず、作成者もその
  データを見られないので、その section を外して作る。
- レポートには原価・予算の section を入れていない（予算の section は #345 の予算・EVM のあとで足す）。
  confidential cost を出すかの選択はその時点で加える。

### 保存場所と token

- Planning table（partition key `workspaceId`）に次の 2 種類の row を置く。どちらも Workspace の partition にあるので、
  tenant purge で一緒に消える。
  - share row: `PROJECT_STATUS_SHARE#<teamId>#<projectId>#SHARE#<shareId>`。範囲、期限、作成者、宛先（Customer と担当者）、
    閲覧回数、最終閲覧日時、取り消し日時と、`reportJson`（snapshot）を持つ。
  - token row: `PROJECT_STATUS_SHARE_TOKEN#<hash>`。share row の位置だけを持つ。
- token は `base64url(workspaceId).secret` で、secret は 32 byte の乱数（base64url）。保存するのは
  `sha256("project-status-share-v1\0" + secret)` だけで、token は作成時の応答で一度だけ返す。
  公開 API は token の前半で Workspace を決め、token row を読み、share row の hash を定数時間で比べる。
- 作成は share row・token row・Project の state row・呼び出し元の fence・audit event を 1 回の TransactWrite で書く。
  取り消しは share row に `revokedAt` を条件付きで書き、token row を消す。
- 上限の確認と作成を直列化するため、Project ごとに `PROJECT_STATUS_SHARE_STATE#<teamId>#<projectId>` の
  `revision` を置く。作成は一覧の前に revision を consistent read で読み、TransactWrite で revision が変わっていない
  ことを条件に 1 進める。同時に作成した 2 件目は 409 になる。
- 作成要求の応答が失われても同じリンクを取り戻せるよう、token の secret と share ID は、要求の idempotency key
  の hash（Workspace と actor を含む）を server の secret で HMAC したものから導く。同じ key の再送は保存済みの
  share を見つけ、内容が同じなら同じ URL を返し、違えば 409 にする。server の secret は Document の公開リンクと同じ
  `DOCUMENT_PUBLIC_SHARE_TOKEN_SECRET` を別の label で使い、新しい secret は足さない。

### 公開 API と無効化

- `GET /api/public/project-status/:token`（と `/pdf`）はサインインなしで呼べる。token の形が違う、知らない、取り消し済み、
  期限切れ、Workspace が閉鎖済み（`enforceActiveTenantForWorkspace`）、Project が archive 済みまたは存在しない、の
  いずれも同じ 404 を返し、どの理由かを区別させない。応答は `Cache-Control: no-store`、`Referrer-Policy: no-referrer`、
  `X-Robots-Tag: noindex` を付ける。
- 期限は 1〜90 日。1 Project あたり有効なリンクは 50 件、保存する share row は取り消し済みを含めて 300 件までとする。

### 権限と監査

- Enterprise の権限表では、PDF の出力（POST）と一覧を `projects.read`、作成と取り消しを `projects.write` にする。
  Project 単位の grant でも使える。
- PDF の出力は Project の viewer。リンクの一覧・作成・取り消しは Project に書き込めるメンバー（RAID log と同じ判定）。
  Customer を宛先にするには Customer の読み取り権限が要り、server は担当者がその Customer にいることを確かめる。
- audit event は `project.status_share_created`・`project.status_share_revoked`・`project.status_share_viewed`。
  metadata は Team・Project・share ID・section・担当者名の有無・期限・宛先で、snapshot の本文は入れない。
- 閲覧は 1 リンクにつき 1 分に 1 回だけ数える。公開 PDF の直接ダウンロードも閲覧として数える。`viewCount`/`lastViewedAt` の条件付き更新と audit event
  （actor は `project-status-share:<shareId>`、kind `system`）を 1 回の TransactWrite で書き、条件に外れた閲覧は記録しない。

### 出力形式

- PDF は Analytics の PDF renderer（`createAnalyticsTextPdf`）を使って server で作る。
- Markdown と PPTX（1 Project 1 枚、16:9、東アジアのフォントは Yu Gothic）は web で作る。
- 印刷は A4 の Document 用 print CSS を使う。

## 検討した選択肢

- 公開時に生データからレポートを作り直す: 常に最新になるが、公開 API が Project・Work Item・メンバーを読むことになり、
  外した section や他の Project の情報が漏れないことを公開側の全経路で守る必要がある。作成時点の snapshot にした。
  最新にしたいときは新しいリンクを作って古いものを取り消す。
- server がレポートを組み立てる: 改ざんの余地はなくなるが、Project overview の集計（schedule・RAID・action item）を
  server にもう一つ作ることになる。作成者は元のデータを読めるので、作成者が自分の画面と同じ内容を送る形にし、
  server は形・大きさ・Project の権限・範囲の適用を確かめる。
- token を share row の key にする: token row が要らないが、token の hash が一覧の key に出て、一覧を Project ごとに
  引けなくなる。share row と token row に分けた。
- Workspace をまたぐ global な token table を足す: table と IAM が増え、tenant purge の対象も増える。token に
  Workspace を埋めて既存の partition に置いた。
- 閲覧をすべて記録する: リンクを何度も開くと audit log が埋まる。1 分に 1 回にした。

## 結果

- 社外のステークホルダーに、サインインなしで範囲を絞ったレポートを渡せる。閲覧回数は一覧で分かり、最終閲覧日時も記録する。
- レポートはリンクを作った時点の内容で、Project を更新しても変わらない。
- PDF は日本語フォントの subset に入っていない文字を、埋め込まない HeiseiKakuGo-W5 で書く（Analytics と同じ）。
  CJK の CMap を持たない viewer ではその文字が出ないことがあるので、ブラウザの印刷（A4）からも PDF にできる。
- 新しい table・index・IAM はない（Planning table の Query / GetItem / TransactWrite だけ）。
- 更新した文書: `docs/guide/pm.md`、`server/README.md`。
