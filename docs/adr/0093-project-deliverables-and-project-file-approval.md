# 0093. Project の成果物一覧を Work Item の閲覧判定から読み、Project file の承認を Project partition に置く

- 状態: 提案
- 日付: 2026-11-24
- 関連: Issue #425

## 背景

Project の成果物を確認するには、Project に直接添付したファイルと、各 Work Item（コメントを含む）の添付を
1 つずつ開いて見る必要があった。承認は Work Item の file だけに対応し、Project に直接添付した file には
依頼できなかった。注釈（annotation）は追加だけで、対応済みにしたり、誤って付けたものを消したりできなかった。

FileProofingTable は file・version・annotation・approval を添付先ごとの partition（`...#WORKITEM#...` または
`...#PROJECT#...`）に保存している。Project 横断の index はなく、file row には作成時の Project が残るだけで、
Work Item を別の Project へ移しても書き換えない。

## 決定

### 成果物一覧

- `GET /api/teams/{teamId}/projects/{projectId}/deliverables` を追加する。新しい table や index は作らない。
- 1 page は Project の Work Item 一覧（`assignedProjectId` index）を `limit` 件読み、その Work Item の partition を
  Query する。1 page 目だけ Project 自体の partition も読む。cursor は Work Item 一覧の cursor をそのまま使う。
- 読む Work Item は「URL の Team が所有し、現在の `assignedProjectId` が URL の Project で、archive されておらず、
  呼び出し元が Project を閲覧できる」ものに限る。file row の作成時の Project ではなく Work Item の現在の割り当てで
  判定するので、閲覧できない Work Item や移動済みの Work Item の添付は返らない。index は結果整合なので、
  候補ごとに canonical Work Item を strongly consistent read で読み直してから判定する。Guest には
  `guestAccess` の file だけを返す。
- Work Item の添付と持ち主（key・タイトル）は、Project の `work-items.read` を持つ人にだけ返す。
  `files.read` だけを持つ Enterprise role には Project 自体の file だけを返す。
- 各 partition は `FILE#` を先に読み、表示できる file があるときだけ `APPROVAL#` と `ANNOTATION#` を読む。
  同時に読む partition は 8 件までにする。
- 承認状態と未解決の絞り込みは page 内で行う。CSV はブラウザが全 page を読んで作る。
- 範囲は URL の 1 Team に限る。Web は選択した Team、なければ Project を持つ唯一の Team を使う。同じ Project ID が
  複数の Team にあり Team を選んでいないときは読まず、Team を選ぶよう案内する。Team をまたぐ一覧は作らない。

### Project file の承認

- `/api/teams/{teamId}/projects/{projectId}/approvals` 配下に作成・判断・取消を追加し、approval row は Project
  partition に `issueId` なしで保存する。subject は `file-version` だけで、`completionTransition` は 400 で拒否する。
- Reviewer は、選出時に decision endpoint と同じく Project の `files.read` と `files.approve` を持つ active member に
  限る。判断できない reviewer を選べると、pending approval が版の差し替えと削除を止めたままになるため。
- Reviewer Inbox と外部通知の配信前の再確認は、Project の現在の閲覧権限と file の削除・guest 共有で行う。
  Audit event の entity は Project にする。Focus は Work Item に紐づく approval だけを扱い続ける。

### 注釈の解決・削除

- 解決・再開は guest 以外の書き込める member、削除は作成者だけが行える。どちらも file の未削除を
  `ConditionCheck` で確かめ、条件付きの Put / Delete と audit event を同じ transaction で保存する。
- 削除は同じ transaction で、scope と idempotency key hash から ID を決めた `ANNOTATION_DELETE#` receipt row
  （作成者・対象・request fingerprint・TTL）を保存する。応答が失われた削除の再送は receipt と一致すれば成功にし、
  存在しなかった annotation の削除は 404 のままにする。整合性検査と restore drill はこの row を補助 row として扱う。
- 未解決件数は file 一覧と approval に派生値として付け、row には保存しない。注釈は次の version に引き継がない。

## 結果

- 新しい index や schema version の変更、データ移行は不要。
- 1 page の読み取りは Work Item 数に比例し、Work Item ごとに canonical row の GetItem が 1 回増える。Work Item が多い Project では、絞り込み後に行がない page がありうる。
- Project 横断の集計 row を持たないため、成果物数の合計や全体の並べ替えはできない。必要になったら
  projection を別途検討する。
- Project の approval は Focus に出ない。対応は別の判断にする。
