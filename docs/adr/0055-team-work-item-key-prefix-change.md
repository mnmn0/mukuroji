# 0055. Work Item key の prefix を Team ごとに変更でき、番号は prefix をまたいで続ける

- 状態: 提案
- 日付: 2026-11-22
- 関連: Issue #640, #375, PR #735

## 背景

Work Item key（`ABC-123`）の prefix は、Team の最初の Work Item を作るときに Team ID から自動で決まり、
変えられなかった（registry の counter row が prefix を持つ）。#640 で「Project code から prefix を
選べるようにする」ことになった。key は Work Item の不変の参照で、Work Item は Team に属し、
Project の割り当ては後から変わる。

## 決定

- prefix は引き続き Team が持つ。Team manager（Workspace の書き込み権限も必要）が
  `PUT /api/teams/{teamId}/work-item-key-prefix` で変更でき、画面は Team の Project code を候補に出す。
  入力は任意の prefix（英字で始まる 2〜10 文字の英数字）も受け付ける。
- 変更は registry の 1 transaction で行う。新しい prefix の `work-item-key-prefix` row を条件付きで置き
  （その Team が以前使った prefix なら所有の確認だけ）、counter row の `keyPrefix` を読み込み時の値を条件に
  書き換える。呼び出し元の権限 row の condition check と audit event（`work-item-key-prefix.updated`）も
  同じ transaction に入れる。
- 以前の prefix row は削除しない。古い key の `work-item-key` row も残るので、古い key は引き続き
  Work Item を開け、`GET /api/work-items/key-prefixes` にも残って link になり、他の Team には取られない。
- 番号は Team の counter から続ける（`PT-2` の次に `ABC` に変えると `ABC-3`）。以前の prefix に戻しても
  番号が重ならないため、key の重複が起きない。
- Team がまだ key を持たないときの変更は、選んだ prefix で counter を作る（`lastNumber` は 0）。

## 検討した選択肢

- Project ごとに key を採番する: Project code がそのまま prefix になる。Project の割り当てを変えても key は
  変わらないため、key の prefix と所属 Project がずれる。Project なしの Work Item には別の prefix が要る。
- prefix ごとに番号を 1 から振り直す: 見た目は自然だが、以前の prefix に戻すと既存の key と衝突する。
  衝突を避けるには prefix ごとの counter が要る。
- 変更時に既存の key を付け替える: 外部に貼られた key と link が壊れる。

## 結果

- Team の都合で prefix を Project code などに揃えられる。古い key と link は壊れない。
- 1 つの Team が複数の prefix row を持つ。prefix 一覧は Team ごとに複数返り得る。
- Team が prefix を手放す（他の Team が使えるようにする）操作は今は無い。必要になったら別に決める。
- 更新した文書: `docs/work-items.md`、`docs/guide/admin.md`。
