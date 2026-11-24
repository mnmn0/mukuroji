# 0092. Document comment の thread 参加者を index row で持ち、編集・削除の冪等性を TTL 付き receipt で持つ

- 状態: 提案
- 日付: 2026-11-24
- 関連: Issue #422、PR #798、ADR 0091

## 背景

Issue #422 で、Document comment の返信を thread の作成者とそれまでの返信者にも通知し、作成者が
自分の comment を編集・削除できるようにした。

- 返信の通知先を求めるには thread の参加者が要る。comment row の sort key は
  `COMMENT#<documentId>#<createdAt>#<commentId>` で Document 単位の時系列なので、thread の返信者を
  集めるには Document の comment を全 page 読むしかない。page 数に上限を置くと、上限を超えた古い
  返信者が黙って通知から漏れる（`server/AGENTS.md` は上限到達を成功として隠すことを禁じている）。
- 編集・削除は、応答が失われた後に同じ `Idempotency-Key` で再送される。comment row を読み直して
  そのまま書くと、再送の間に入った新しい編集を古い内容で上書きしてしまう。

## 決定

`DocumentsTable` の Workspace partition に、次の 3 種類の row を追加する。どれも comment の書き込みと
同じ transaction で書く。

- **Thread 参加者 row**
  - sort key: `COMMENT_PARTICIPANT#<documentId>#<rootCommentId>#<memberKey>`（各部分は base64url）
  - entryType: `document-comment-participant`
  - comment を作るたびに、作成者の row を条件なしの Put で書く（同じ member は上書きになるだけ）。
  - 返信時は、その thread の prefix を `LastEvaluatedKey` が尽きるまで読む。件数は thread の
    参加者数で決まる。
- **Index 完了 marker row**
  - sort key: `COMMENT_PARTICIPANT_INDEX#<documentId>#<rootCommentId>`
  - entryType: `document-comment-participant-index`
  - 新しい root comment を作るときに書く。参加者 row の root 作成者とは別の row にするので、古い
    thread で root 作成者が返信しても、index が揃ったことにはならない。
  - marker がない（index ができる前の）thread は、Document の comment を全 page 読んで参加者を
    集める。参加者が 25 人（`DOCUMENT_THREAD_PARTICIPANT_BACKFILL_LIMIT`）以下なら、全員の
    参加者 row と marker を返信の transaction で書き足し、以後は index だけを読む。25 人を超える
    thread は書き足さず、返信のたびに全 page を読む。どちらの経路でも page を打ち切らない。
- **編集・削除の receipt row**
  - sort key: `COMMENT_MUTATION#<documentId>#<hash>`。hash は
    `sha256(Workspace ID, 正規化した member key, Idempotency-Key)` から作り、key を member ごとに分ける。
  - entryType: `document-comment-mutation`
  - 操作（`updated` / `deleted`）・comment ID・入力（本文と mention）の fingerprint と、
    最初の応答の comment を持つ。
  - comment の変更と同じ transaction で、`attribute_not_exists` または期限切れを条件に書く。
  - TTL は `expiresAtEpoch` に 30 日（`DOCUMENT_OPERATION_RECEIPT_RETENTION_DAYS`）で付ける。
    既存の Document operation receipt と同じ保持期間と条件式にしている。
  - 同じ key の再送は receipt の結果を返し、comment を書き換えない。fingerprint が違えば
    `409 DocumentCommentIdempotencyConflict` を返す。
  - 書き込み競合で transaction が失敗したときも、receipt を読み直して replay を確かめる。

## 検討した選択肢

- Comment row に thread 用の GSI を足す: thread を直接 query できるが、table 定義・CDK・既存 row の
  backfill が要る。返信の通知のためだけに Document の全 comment を index するのは重い。
- 参加者一覧を root comment row の属性に持つ: 読み込みは 1 回で済むが、返信のたびに root row を
  更新するため、root の `updatedAt` を条件にした resolve・編集と競合する。row の大きさも参加者数に
  比例して育つ。
- 古い thread の参加者を別の batch migration で一括 backfill する: 返信時の全件読みはなくなるが、
  data migration runner の手順と operator の実行が要る。返信時の backfill で、使われる thread から
  順に揃う。
- 編集・削除の冪等性を audit event ID の衝突だけで判定する: 追加の row は要らないが、audit table を
  設定しない環境では検出できず、replay の結果も返せない。
- Receipt に TTL を付けない: 古い key の再送も検出できるが、comment の変更ごとに row が無期限に
  増える。再送は応答が失われた直後に限られるので、operation receipt と同じ 30 日にした。

## 結果

- 返信の通知が、Document の comment 数によらず thread の全参加者に届く。index のある thread では、
  返信時の読み込みは参加者 row と marker だけになる。
- 参加者が 25 人を超える古い thread は、返信のたびに Document の comment を全 page 読む。必要に
  なったら data migration で marker と参加者 row を一括で書く。
- 参加者 row は comment を削除しても残る（削除した人も通知を受け取る）。
- 編集・削除の再送は、後から入った新しい編集を巻き戻さない。30 日を過ぎた key の再送は新しい
  変更として扱う。
- 更新した文書: `docs/documents.md`。
