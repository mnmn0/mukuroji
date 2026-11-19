# 0002. Project のリスク・課題・変更要求を Planning table の1登録1行で持つ

- 状態: 提案
- 日付: 2026-11-19
- 関連: Issue #344

## 背景

Project ごとにリスク・課題・変更要求（RAID）を登録し、更新・close して audit に残す台帳が要る（#344）。
1 Project あたり数百件、1件あたり最大 2,000 文字の自由記述を2つ持つ。日本語の UTF-8 は1文字最大3 byte なので、
全件を1行に入れると DynamoDB の 400 KB の item 上限を超える。新しい table は増やしたくない（コストと運用）。

## 決定

- 既存の Planning table（`workspaceId` / `recordKey`）に、登録1件を1行として置く。
  record key は `PROJECT_RAID#<teamId>#<projectId>#ENTRY#<entryId>`（各 ID は `encodeURIComponent`）、
  `entryType = project-raid-entry`。
- 同じ Project の件数カウンタを `PROJECT_RAID#<teamId>#<projectId>`（`entryType = project-raid-log`）に置き、
  追加の transaction で `entryCount < 300` を条件に1増やす。
- 一覧は `begins_with(recordKey, PROJECT_RAID#<team>#<project>#ENTRY#)` の Query を全ページ読む。
- 更新は登録ごとの `revision` を CAS にし、呼び出し元の membership / Enterprise revision の fence と
  audit event を同じ transaction に入れる。
- 登録 ID は Idempotency-Key・actor・Project から決まる hash にし、同じ request の再送は保存済みの登録を返す。

## 検討した選択肢

- Project ごとに1行（baseline と同じ形）: 読み書きが1回で済むが、item 上限に当たる。件数を小さく絞るのも台帳として不足。
- 新しい table: 境界は明確だが、table・IAM・backup の運用が増える。Planning table の既存 IAM で足りる。
- Work Item の curated `risk` item を流用: Work Item ごとの注釈で、Project 単位の状態・見直し期限・変更要求を持てない。

## 結果

- 1 Project 300 件まで保存できる。上限は、全件を返す一覧の応答が自由記述を最大まで使っても Lambda の 6 MB 応答上限に収まるように決めた。一覧は Query 1回（1 MB ごとに次ページ）で読める。
- 削除はなく、close / reopen を状態で表す。件数カウンタは close でも減らない（上限は登録の総数）。
- 変更要求の承認と baseline・日程への反映、Focus・通知、CSV・Public API は未実装（#344 に残す）。
- 利用者ガイドは `docs/guide/pm.md` を更新した。
