# 0065. Project の予算レポートと EVM を baseline・進捗・工数から都度計算し、予算を Team と Project の組で保存する

- 状態: 提案
- 日付: 2026-11-23
- 関連: Issue #345、#336（schedule baseline）、#398（単価表・期間別予算）、ADR 0016、ADR 0028、ADR 0043

## 背景

予算を持つ社内 Project では、予算に対する実績コスト・工数の消化と、計画に対する出来高（EVM）で進捗を報告する。
予算（`TimeBudget`）、工数 entry の実績コスト、Project の schedule baseline（予定日と予定工数、#336）、
Work Item の進捗（Team の `progressMode`）はすでに保存されているが、それらを比べる read model がない。

既存の Project 予算は `TIME_BUDGET#project#<projectId>` に保存していた。Project ID は Team の中でしか一意で
ないため（ADR 0028）、別 Team の同じ Project ID と同じ row を読み書きしてしまう。

## 決定

1. `GET /api/teams/:teamId/projects/:projectId/budget-report`（と同じ内容の `/export` CSV）を追加し、
   保存済みの値から毎回計算する。集計 row や snapshot は保存しない。
2. Project の manager だけが読める（system administrator、direct Team grant、その Project の manager role）。
   全メンバーの工数と confidential な実績コストを合計するため、一般メンバーには工数だけの版も返さない。
3. 計算規則:
   - BAC（工数）は active baseline の `plannedEffortMinutes` の合計。現在 canceled の Work Item は BAC・PV・EV から除く。
   - PV は各 baseline Work Item の予定工数を、計画開始日〜終了日の暦日に均等に配る。終了日だけなら終了日に全量、
     終了日がなければどの日にも置かない（BAC には含め、`unscheduledEffortMinutes` として返す）。
   - EV は baseline の予定工数 × 各 Work Item の現在の進捗（`deriveWorkItemProgressPercent` と Team の `progressMode`）。
     archive 済みの Work Item も読み、削除済みは 0 とする。
   - AC は Project に付いた工数 entry（状態を問わない）の分を、entry の開始日（report の timezone）で数える。
     期間は `from` から `asOf`（今日と `to` の早い方）まで。
   - 金額は予算額 ÷ BAC（工数）を 1 分あたりの単価として PV・EV を換算し、AC は予算通貨の実績コストだけを使う。
     単価のない entry は工数にだけ入る。他通貨は換算しない。
   - SPI = EV / PV、CPI = EV / AC、EAC = BAC / CPI、ETC = EAC − AC、VAC = BAC − EAC。分母が 0 のときは返さない。実績があって出来高が 0 なら CPI は 0 とし、EAC・ETC・VAC は返さない。
4. Project 予算の保存 key を `TIME_BUDGET#project#<teamId>#<projectId>` に変え、`TimeBudget` に `teamId` を持たせる。
   Team 予算の key（`TIME_BUDGET#team#<teamId>`）は変えない。まだ deploy していないので既存 row の移行はしない。

## 検討した選択肢

- 日次の EVM snapshot を worker で保存する: 過去の EV を正確に残せるが、worker・table 設計・backfill が要る。
  まずは都度計算にし、Analytics の snapshot に EVM metric を足す段で過去値の再現を扱う。
- 金額の PV を Work Item ごとの単価（単価表 #398）で積み上げる: 担当者が決まっていない計画には単価がない。
  予算額を BAC で割る方式なら予算を持つ Project で必ず計算でき、予算と PV の合計が一致する。
- 工数だけの版を一般メンバーにも返す: Project なし・Work Item なしの他人の工数を含むため、ADR 0027 の
  「一般メンバーには本人分だけ」と矛盾する。manager 限定にした。
- 予算 key を projectId のまま、読み取り側で Team を照合する: 別 Team の書き込みで上書きされる問題が残る。

## 結果

- Project 概要に予算・EVM のセクションを出し、CSV で同じ値を出せる。
- EV は「今の進捗」から計算するため、過去日の EV は系列に出さない（PV と AC だけ）。
- 予算は Project ごとに 1 件のまま。年度・期間ごとの複数予算は #398 で、この key の後ろに期間を足して扱う。
- 残り（経費 entry、閾値通知と Automation trigger、Analytics metric・widget・snapshot、PMO dashboard の widget）は
  #345 の続く PR で入れる。
- 更新した文書: `docs/time-tracking.md`、`docs/guide/pm.md`。
