# 0104. Project の経費を Planning table に1件1行で保存し、申請者以外の Project manager の承認で予算の実績に入れる

- 状態: 提案
- 日付: 2026-11-26
- 関連: Issue #345、ADR 0065（Project 予算レポートと EVM）、ADR 0093（Project file）、ADR 0016

## 背景

Project の予算は人件費（工数 × 単価）だけでは消化しない。外注費・ライセンス・交通費などの経費を記録する entity がなく、
予算レポート（ADR 0065）の実績コストと消化率は工数のコストだけを数えていた。経費は日付・科目・金額・通貨・関連 Work Item・
承認状態・証憑 file を持ち、承認されたものだけを予算消化に含めたい。

## 決定

1. 経費は Planning table に1件1行で保存する。key は `PROJECT_EXPENSE#<teamId>#<projectId>#ENTRY#<expenseId>`（各 ID は
   URL encode）、同じ prefix の `PROJECT_EXPENSE#<teamId>#<projectId>` に件数 counter を置き、1 Project 2,000 件までにする。
   追加は経費行・counter・呼び出し元の認可 fence・audit event を1つの transaction で書き、削除は counter を減らす。
   削除は同じ transaction で `PROJECT_EXPENSE#<teamId>#<projectId>#DELETED#<expenseId>` に削除 receipt（request の
   Idempotency-Key と内容の digest）を残し、応答を失った削除の再送は経費がなくても同じ receipt なら `204` を返す。
   経費 ID は Idempotency-Key から決まるので同じ ID の経費は再び作られず、receipt は一覧の prefix の外に置く。
   audit event の変更には金額・費目・説明・判断メモの値を残さない（audit を読めても Project を管理できない人に金額を見せない）。
   Project ID は Team の中でしか一意でないので（ADR 0028）、key に Team を含める。
2. 経費の ID は Idempotency-Key から決めるので、同じ要求の再送は同じ経費を返し、同じ key で別の内容なら 409 にする。
   更新・承認は revision で世代を確かめ、要求の receipt を行に残して再送を見分ける（RAID log と同じ）。
3. 読み書きとも Project manager だけ（予算レポートと同じ `requireTeamProjectManager`、Enterprise は `projects.manage`）。
   金額は予算消化の機密値と同じ扱いにする。
4. 状態は `submitted` → `approved` / `rejected`。申請した manager はその経費を承認・却下できず、別の Project manager
   （Team の manager、system administrator を含む）が決める。却下した経費は直して再申請でき（`submitted` に戻り、申請者は
   直した人になる）、承認済みの経費は変更も削除もできない。削除の transaction は「承認済みでない」ことも条件にする。
5. 証憑は Project の file（ADR 0093 の Project scope）の File ID を最大5件持つ。追加する ID は、その Team と Project の
   file であることを file の逆引き index で確かめる。証憑の中身は Project file の閲覧規則に従う。
6. 予算レポートは、`from`〜`asOf` の日付の承認済み経費を `approvedExpenseByCurrency`、承認待ちを
   `pendingExpenseByCurrency` に返す。予算通貨の承認済み経費は工数コストと合わせて実績コスト（系列の `actualCostMinor`、
   EVM の金額 AC、`budgetConsumedPercent`）に入れる。他通貨は換算しない。工数の値（AC 分）には入れない。

## 検討した選択肢

- 工数 entry と同じ time tracking table に置く: 工数の GSI・締め・承認の流れと混ざる。経費は月の締めの対象にせず、
  Project 単位で読めればよいので、Project ごとの prefix で読める Planning table にした。
- 一般メンバーも申請できるようにする: 本人分だけを見せる読み取りと、承認者だけが全件を見る読み取りを分ける必要がある。
  まずは manager 同士の申請・承認にし、メンバーの申請は必要になったら足す。
- 申請者の自己承認を許す: 1人で予算を消化済みにできてしまう。manager が1人の Project では Team の manager が承認する。
- 証憑を経費専用の file scope に置く: file の upload・scan・閲覧の仕組みを複製することになる。既存の Project file を使う。

## 結果

- Project 概要の予算セクションの下に **経費** を表示し、申請・承認・却下・削除と証憑の添付ができる。
- 予算レポートの実績コストと消化率、CSV（承認済み・承認待ちの経費の列）に経費が入る。
- 証憑の file が後で削除されても、経費の File ID は残る（経費は削除済み file を指したままになる）。
- 予算消化率の閾値通知と Automation trigger は ADR 0105 で扱う。
- 更新した文書: `docs/time-tracking.md`、`docs/guide/pm.md`。
