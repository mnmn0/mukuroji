# 0030. 週報を Planning table に週ごとの行と提出版ごとの行で持ち、読む人の権限でタスクを絞る

- 状態: 提案
- 日付: 2026-11-20
- 関連: Issue #631（#348 の残り）、ADR 0024

## 背景

#348（PR #591）で、メンバーは自分のタスクと工数から個人週報の下書きを作り Markdown でコピーできるようになった。
しかし週報は保存されず、書き足した所感は画面を閉じると消える。提出・履歴・上長が読む場所もない（#631）。

週報には作成者が読めるタスクの title が載る。上長が同じタスクを読めるとは限らないので、
提出した週報をそのまま見せると、読む人が権限のないタスクの title を週報経由で読めてしまう。
作成者の権限で固定するか、読む人ごとに絞るかを決める必要がある。

新しい table は増やしたくない（コストと運用）。週報は Team ごと・メンバーごと・週ごとに1つで、
1件はタスク最大 150 件と自由記述2つ（各 4,000 文字）に収まる。

## 決定

### 保存先と key

既存の Planning table（`workspaceId` / `recordKey`）に、2種類の行を置く。各 ID は `encodeURIComponent` する。

- 週の行: `WEEKLY_REPORT#<teamId>#MEMBER#<memberKey>#W#<weekStart>`（`entryType = weekly-report`）。
  書きかけの所感（課題・所感の2つ）、所感の `revision`、提出回数 `submissionCount`、最後の提出時刻を持つ。
- 提出版の行: `WEEKLY_REPORT#<teamId>#MEMBER#<memberKey>#S#<weekStart>#<version 4桁>`
  （`entryType = weekly-report-submission`）。提出した内容の写しで、`attribute_not_exists` で1回だけ書き、更新しない。

`memberKey` は小文字に正規化した Workspace member key、`weekStart` は `YYYY-MM-DD`。

- 所感の保存は週の行の `revision` を CAS にする。
- 提出は1つの transaction で、週の行の `submissionCount` を CAS で1増やし（所感も同時に保存）、
  提出する所感が編集を始めた時点の `revision` も照合して、別の画面で保存された所感を黙って置き換えない。
  提出版の行を追加し、呼び出し元の membership / Enterprise revision の fence と audit event を入れる。
  1週あたりの提出は 10 版まで。同じ Idempotency-Key の再送は、週の行に残した最後の提出の receipt で見分けて保存済みの版を返す。
- 自分の履歴は `begins_with(…#MEMBER#<memberKey>#W#)` の Query を新しい週から読む（ページ送り付き）。
- 1つの週は週の行の Get と `…#S#<weekStart>#` の Query で読む。
- 上長の提出状況一覧は、対象メンバーの週の行を BatchGet で読む。
  その週に提出がないメンバーは、前後6日に始まる週の行を `BETWEEN` の Query で探し、提出済みで開始日が最も近い週を
  保存時の開始日つきで返す。Workspace の週の開始曜日を変えた後も、変える前に提出された週報を上長が読めるようにするため。

### 提出内容はサーバーが Work Item から解決する

Web は下書きの各欄（完了・着手・期限超過・来週・工数）に載せる Work Item の ID と工数（分）だけを送る。
サーバーは作成者の権限で各 Work Item を読み、key・title・予定終了日・所属 Project を Work Item から写す。
作成者が読めない、または存在しない Work Item は捨てる。各欄の分類と工数は作成者の申告として保存する。

### 読む人ごとに絞る

週報を返すとき、各タスクを **読む人の今の権限** で絞る。読む人がそのタスクの Project を viewer 以上で読めない
（Project 未割当のタスクは Team を読めない）場合、そのタスクは key・title・ID を消し、工数だけを
「閲覧権限のないタスク」として返す。作成者本人も同じ規則で読む（後で Project を外れた場合も同じ）。
課題・所感の自由記述は作成者が書いた文なので絞らない。
Enterprise の role で読む人は、Team を読めるだけでは足りず、そのタスクの Project（Project 未割当なら Team）で
`work-items.read` を持つ必要がある。

### 誰が読めるか

- 作成者本人: 自分の書きかけと全提出版、履歴。書き込みは本人だけ。
- Team の管理者（システム管理者、Enterprise を使っていない Workspace の owner / admin、Enterprise の `teams.manage`、またはその Team の Project の manager）:
  自分が manager の Project のメンバー（Team 全体の管理者なら Team の全 Project のメンバー）の提出版と履歴、
  その週の提出状況（提出済み・未提出）。書きかけの所感は読めない。
  Project のメンバーかは旧形式の Project 権限を Team に結び付けて判定し、複数の Team が同じ Project ID を持つ曖昧なものは数えない。

## 検討した選択肢

- 作成者の権限で固定して全文を見せる: 実装は単純だが、読む人が権限のないタスクの title を読める（#631 の完了条件に反する）。
- Web が組み立てた週報（title 付き）をそのまま保存する: title と Project の対応を client が決めることになり、
  読む人ごとに絞るときの根拠にできない。
- サーバーが下書きを一から組み立てる: 分類が正確になるが、メンバーの time zone で工数を日ごとに切る処理を
  サーバーへ移す必要がある。今回は Work Item の解決だけをサーバーで行い、分類は Web の既存ロジックを使う。
- 週ごとに1行だけ（版を持たない）: 提出後の修正で前の版が消え、「提出した版は変更不可」にならない。
- 新しい table: 境界は明確だが、table・IAM・backup の運用が増える。Planning table の既存 IAM で足りる。

## 結果

- 提出した版は変更されず、再提出は新しい版として残る。1版の大きさはタスク 150 件と自由記述で約 250 KB に収まり、
  DynamoDB の 400 KB 上限に余裕がある。週の詳細は最新版だけを返し、古い版は版番号を指定して読む。
- 読む人の権限が変わると、同じ提出版でも見えるタスクが変わる。title を隠したタスクも工数は合計に残る。
- 工数・分類は作成者の申告で、タイムシートの値とは独立している。
- Team / Project の週次まとめ、未提出の督促、Slack / Email 配信、AI 要約は未実装（#631 に残す）。
- 利用者ガイドは `docs/guide/member.md`・`pm.md` を Web の対応と一緒に更新する。
