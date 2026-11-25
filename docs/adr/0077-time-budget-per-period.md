# 0077. 期間ごとの予算は、期間を key に含めた別の予算 row として保存する

- 状態: 提案
- 日付: 2026-11-25
- 関連: Issue #398、[0076](0076-workspace-wide-time-period-close.md)

## 背景

Team と Project の予算は scope ごとに1つ（`TIME_BUDGET#team#<teamId>`、`TIME_BUDGET#project#<teamId>#<projectId>`）で、
期間は任意の属性だった。月や四半期ごとに予算を立てる運用では、期間を変えるたびに前の予算を上書きすることになり、
過去の期間の予算と実績を比べられない。Issue #398 は期間別の予算を求めている。

## 決定

- 期間ごとの予算は、既存の予算 row とは別に、期間を key に含めた row として保存する。
  `TIME_BUDGET#team#<teamId>#PERIOD#<from>#<to>` と `TIME_BUDGET#project#<teamId>#<projectId>#PERIOD#<from>#<to>`。
  row は `periodBudget: true` を持つ。期間のない既存の row は「既定の予算」としてそのまま残し、移行は行わない。
- 保存は既存の `PUT .../time-budget` に `periodBudget: true` と `periodFrom` / `periodTo`（両方必須）を付けて行う。
  revision による楽観的排他は既定の予算と同じで、同じ期間の row があれば置き換える。
- 削除は `DELETE .../time-budget/periods/:periodFrom/:periodTo?expectedRevision=N`（204）。revision が違えば 409、
  ない期間は 404。audit event `time-budget.deleted` を同じ transaction で書く。
- 同じ scope の期間ごとの予算は、日付が重なる保存を 409 `TimeBudgetPeriodOverlap` で拒否し、1 scope に 40 件まで
  （409 `TimeBudgetPeriodLimit`）とする。重なりの確認は保存前の Query で行う best effort で、同時に保存された2件は重なり得る。
- 集計 API（`GET .../time-tracking/summary`）は、集計期間とちょうど同じ期間の予算があればそれを `budget` に返し、
  なければ既定の予算を返す。scope の期間ごとの予算は `budgetPeriods` に一覧で返す。
- Project の予算と出来高（`budget-report`）は、これまでどおり既定の予算を使う。

## 理由

- 期間を key に入れると、既定の予算の読み書きと、既存の row・IAM・migration を変えずに足せる。
  scope の期間ごとの予算は begins_with の Query 1回で読める。
- 「集計期間と完全に一致する期間」で選ぶと、どの予算と比べているかが利用者に明確で、期間の按分のような
  推測を入れずに済む。
- 重なりを transaction で完全に防ぐには scope ごとの lock row が要る。予算は管理者が手で入れる少数の row なので、
  保存前の確認と画面の一覧で十分とする。

## 影響

- 集計期間を変えると、比べる予算が既定の予算と期間ごとの予算の間で切り替わる。画面は期間ごとの予算に印を付ける。
- 集計期間が期間ごとの予算とちょうど同じ間は、画面から既定の予算を編集できない。集計期間を変えれば編集できる。
- `budget-report` と Portfolio の予算列は、期間ごとの予算をまだ使わない。
