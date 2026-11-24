# 0091. 名前付き version を TTL なしの snapshot で残し、承認は成果物の Work Item に既存の approval として作る

- 状態: 提案
- 日付: 2026-11-24
- 関連: Issue #421、#354

## 背景

設計書などの成果物には「v1.0 をレビューして承認した」という記録が要る。Document の version は
metadata・delta・snapshot のすべてに 180 日の DynamoDB TTL が付き、承認の仕組みは upload した
file の version と Work Item 本体にしかなかった。承認の結果は Document と Work Item の両方に
表示したい。

## 決定

- Version に名前を付けて固定できるようにする。固定すると `DocumentsTable` の
  `VERSION#<documentId>#<revision>` row から `expiresAtEpoch` を外し、`name`・`pinnedAt`・
  `pinnedByUserId` を持たせる。同じ transaction で、その revision の full snapshot を
  `VERSION_SNAPSHOT#<documentId>#<revision>` に TTL なしで書く。固定した version は後続の delta
  や base snapshot が期限切れで消えても、単独の snapshot から読める。
- 承認の対象に `'document-version'` を加え、`documentId` と `versionId` を subject として持つ。
  承認 row は成果物として link する Work Item の file proofing scope に置き、file version の承認と
  同じ row・reviewer projection・summary・audit / 通知の event を使う。承認依頼は固定済みの version
  だけに出せ、guest は reviewer にしない。
- Document 側から承認を引くため、file proofing table に
  `WORKSPACE#<workspaceId>#DOCUMENT#<documentId>` / `APPROVAL#<createdAt>#<approvalId>` の不変な
  pointer row を承認作成と同じ transaction で書く。一覧では pointer から main row を batch read
  し、閲覧者が Work Item を見られる承認だけを返す。
- Document の閲覧確認は documents module、Work Item の認可・reviewer 検証・承認の保存は
  API composition（`server/src/api/shared/document-approval-access.ts`）が行う。documents module は
  `DocumentApiDependencies` の任意の callback を通してだけ承認に触れ、files module に依存しない。

## 検討した選択肢

- 承認を Document 側（documents table）に持つ: Document 単独で完結するが、reviewer Inbox、通知、
  Work Item の承認集計と完了 Gate を作り直すことになる。成果物としての link も別に要る。
- 固定時に TTL だけ外し snapshot を書かない: 書き込みは減るが、固定 version の復元に使う delta と
  base snapshot が期限切れで消え、180 日後に内容を確認できなくなる。
- Document の承認一覧を Document の Work Item relation から引く: index は要らないが、link していない
  Work Item に出した承認を見落とし、relation を外すと承認が見えなくなる。
- Workspace ごとに保持期間を設定する: issue の「やること」にあるが、TTL は version 作成時に決まるため、
  設定を変えるには全 mutation で Workspace 設定を読み、既存 row の TTL を書き換える migration が
  要る。今回は保持期間（180 日）を docs に明記し、固定で長期保存の必要に応える。

## 結果

- 固定した version は保持期間を過ぎても preview・比較・復元・承認の対象として残る。固定 version の
  数だけ snapshot が無期限に残るが、固定は編集者の明示操作に限る。
- 承認の判断・取消・通知・完了 Gate は既存の Work Item 承認と同じに振る舞う。Document 側の
  pointer row は不変で、Work Item や承認の削除後は main row がないものとして読み飛ばす。
- Reviewer が Document を閲覧できるかは承認作成時に検証しない（Work Item の閲覧だけを確かめる）。
  Document を読めない reviewer は版を開けないため、必要なら後で検証を足す。
- 固定の解除、Workspace ごとの保持期間は見送った。
- 更新した文書: `docs/documents.md`、`docs/guide/member.md`。
