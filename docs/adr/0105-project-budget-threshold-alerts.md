# 0105. Project 予算の消化率を毎日1回調べ、通知の閾値に達した予算ごとに1回だけ通知と Automation trigger を出す

- 状態: 提案
- 日付: 2026-11-26
- 関連: Issue #345、ADR 0065（Project 予算レポートと EVM）、ADR 0077（期間ごとの予算）、ADR 0095（利用期限の通知）、ADR 0104（Project の経費）

## 背景

Project の予算は消化率（工数コスト + 承認済み経費、ADR 0104）を予算レポートで見られるが、予算に近づいても誰にも知らせない。
Issue #345 は「予算 90%（設定値）到達時に責任者へ通知」と、同じ到達で動く Automation trigger を求めている。
消化率は工数の記録・修正、経費の承認、予算額の変更のどれでも変わり、書き込み側で毎回測ると time tracking と経費の
両方の書き込みに Project の全工数の読み取りが入る。

## 決定

1. Project の既定の予算（期間ごとの予算ではない方）に `alertPercent`（1〜1000 の整数、省略時 90）を持たせる。
   保存で省略したときは保存済みの値を残す。Team の予算と期間ごとの予算には持たせない。
2. 毎時の notification schedule のうち、日本時間（既定の Workspace time zone、timesheet の催促と同じ時計）で 9 時の回だけが Workspace ごとに active な Project の予算を読み、
   予算レポートと同じ数え方（予算通貨の工数コスト + 承認済み経費、Workspace の time zone の日付）で、予算期間の開始
   （期間がなければ最初の記録）から今日（期間が終わっていれば期間の終わり）までの消化率を測る。
3. 消化率が `alertPercent` 以上なら `project-budget.threshold-reached` の audit event を1件書く。event ID は Workspace、
   Project、予算期間、予算額、通貨、閾値から決めるので、同じ予算の間は翌日以降も重複になり、通知は1回だけになる。
   予算額・期間・閾値を変えると新しい予算として、また閾値以上なら1回通知する。
4. 通知先は Project manager に限る（金額は機密値なので、event は割合だけを持ち、金額は持たない）。charter の owner が
   その Project の manager ならその人だけ、owner がいない・manager でないときは Project の manager 全員にする。
   配信時と外部 channel の送信前に、受信者がまだその Project の manager かを確かめ直す。
   manager は、Project の manager member に加えて、Enterprise role の直接割り当てでその Project か所属 Team に
   `projects.manage` を持つ member も含める。directory group への割り当ては、group の所属がその member の
   sign-in 時にしか分からず、毎朝の判定では読めないので含めない。このため notification schedule job は
   Enterprise identity table を読み取り専用で読む。
   受信者に Enterprise role が効いている Workspace では、配信時にも外部 channel の送信前にも、その role が今も Project の
   `projects.manage` を持つかを確かめ、古い manager member 行だけでは届けない（予算レポートと経費の API と同じ判定）。
   毎朝の判定でも同じ規則で manager を絞る。Enterprise role が効く人はその role が Project を管理するときだけ、効かない人は
   manager member 行で数える。owner が manager でなくなっていればほかの manager 全員に送る。sign-in 時にしか分からない
   group への割り当てがあって owner を判定しきれないときは、owner だけに絞らず manager 全員に送る。
   Workspace のアクセス期限が切れた・無効になった member は配信で落ちるので、毎朝の判定でも owner を選ぶ前に外す
   （期限切れの owner だけに送って誰にも届かない、を避ける）。member 行は Team を持たず、Project ID は Team の中でしか
   一意でないので、同じ Project ID が別の Team にもあるときは manager member 行を根拠にしない。その場合も Team ごとの
   Project は判定から外さず、Enterprise role で manager になる人（owner もその場合だけ優先）を宛先にする。
   閾値の判定は丸めた消化率ではなく実コストの整数比較（`actualCostMinor × 100 ≥ 閾値 × 予算額`）で行う。
   消化率と閾値は通知の message にだけ入れ、audit event の summary には入れない（audit を読めても Project を管理できない人がいる）。
5. Automation に `budget-threshold` trigger を足す。この event で動き、Team の rule は自分の Team の Project の event でだけ
   動く。event に Work Item はないので、Work Item を変える action と担当者への通知は保存時に拒否する（form・webhook
   trigger と同じく対象がない）。通知（相手を指定）・作成・webhook の action は使える。
6. PMO dashboard（Team portfolio）の予算消化にも、予算期間の承認済み経費を足す。

## 検討した選択肢

- 書き込み側で測る: 工数・経費・予算の書き込みのたびに Project の全工数を読むことになり、書き込みが遅く・高くなる。
  1日の遅れは予算の通知には十分なので、schedule で測る。
- 毎時測る: 予算のある Project ごとに全工数を毎時読むことになる。日次で十分とした。
- 閾値に達したことを state 行に残す: 決定的な event ID で重複を防げるので、行を増やさない。audit event の保存期間
  （既定 2,555 日）を過ぎると同じ予算でもう一度通知されうるが、許容する。
- 通知の閾値を Team の通知設定に置く: Project ごとに予算額と一緒に決める値なので、予算に置いた。

## 結果

- Project の予算の編集に「通知する消化率（%）」が増える。
- 閾値に達した翌朝 9 時（日本時間）に、owner か Project manager に通知が届き、`budget-threshold` の rule が動く。
- notification schedule は analytics table の予算（GetItem）と planning table の経費（Query）を読む権限を持つ。
- 更新した文書: `docs/time-tracking.md`、`docs/automation.md`、`docs/guide/pm.md`、`docs/guide/admin.md`。
