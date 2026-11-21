# 0027. Project なしの工数を Team の工数管理者が扱い、集計は一般メンバーには本人分だけ返す

- 状態: 提案
- 日付: 2026-11-20
- 関連: Issue #628、PR #650、Issue #630（間接作業）

## 背景

工数の管理（ほかのメンバーの entry の一覧・編集・履歴・承認・差し戻し・ロック・コスト）は Project 単位で
決めていた。entry に保存された Project を管理する人だけが扱え、Project を持たない entry（Project に
属さない Work Item に記録した工数）は system administrator しか扱えなかった。さらに一覧と集計の
Project allowlist が Project なしの entry を落としていたので、記録した本人のタイムシートにも、
承認キューにも出なかった。

一方で timesheet・summary・CSV export は利用者で絞らず、Project allowlist 内の Team 全員の entry を
集計していた。Web は Team の timesheet を管理者にだけ見せていたが、API では一般メンバーも Team 全体の
日別・週別の合計と、メンバー別の集計を読めた。Web は管理者かどうかを timesheet の `costsRedacted` で
推測していた。

Project なしの Work Item 自体は、Team のどれかの Project に role を持つ人が読め、member なら書ける。
Project なしの Work Item の実績日を直せるのは Team の manager（Team のどれかの Project の manager か、
Team への直接 grant）である。

## 決定

- 「Team の工数管理者」を、Team に対する manager 判定（`requireTeamPermission(..., 'manager')`）が通る人と
  定める。Team のどれかの Project の manager、Team への直接 grant（`teams.manage`）、system administrator。
- Project を持たない entry は Team に属するものとして扱う。記録した本人に加え、Team の工数管理者が
  一覧・編集・履歴・承認・差し戻し・ロック・コストの参照をできる。判定は entry に保存された `projectId`
  だけで行い、Work Item には頼らない。Work Item を持たない間接作業 entry（#630）も同じ規則に乗る。
- Project を持つ entry の規則は変えない。ほかのメンバーの entry は、その Project を管理する人だけが扱う。
- timesheet・summary・CSV export は、一般メンバーには本人の entry だけを集計する。Team の工数管理者には
  本人の分と、管理する Project および Project なしのほかのメンバーの分を集計する。管理していない Project の
  ほかのメンバーの分は、閲覧できても集計に入れない。
- 例外として、Work Item 単位の集計（`groupBy=work-item`）は、閲覧できる Project 内と Project なしの全員分を
  集計する。Work Item を見られる人が、見積と実績を比べるため（Work Item 詳細の工数欄が使う）。コストは
  この場合も管理する Project と Project なしの分だけに出す。
- summary と timesheet の応答に `canManageTeam` を追加し、Web は管理者かどうかをこれで判定する。

## 検討した選択肢

- 選択肢 A（採用）: Team の工数管理者に Project なしの entry を扱わせる。Project なしの Work Item の
  実績日の訂正と同じ範囲で、追加の権限モデルが要らない。欠点は、Project を 1 つ管理するだけで Team の
  ほかのメンバーの Project なしの工数とコストが見えること。
- 選択肢 B: Team への直接 grant と system administrator だけに扱わせる。範囲は狭いが、Project の role しか
  使わない運用では誰も承認できず、#628 の「manager の承認キューに出る」を満たせない。
- 選択肢 C: Project なしの Work Item では工数の記録を止める。可視性の問題は消えるが、間接作業（#630）など
  Project に属さない時間を記録できなくなる。
- 集計の範囲について、timesheet だけを本人分にする案は、summary の `groupBy=user` や `day` で同じ合計が
  読めるので採らなかった。Work Item 単位の集計まで本人分にする案は、Work Item の見積と実績の比較を
  壊すので採らなかった。

## 結果

- Project なしの工数が本人のタイムシートと Team の工数管理者の承認キューに出る。一般メンバーは API でも
  ほかのメンバーの工数の内訳を読めない。
- 受け入れる欠点: Work Item 単位の集計は全員分なので、Work Item ごとの合計を足せば Team 全体の時間は
  おおよそ分かる。1 人だけが記録した Work Item ではその人の時間も分かる。メンバー別・日別の内訳を
  隠すことを優先し、これは許容する。
- 管理者の集計から、管理していない Project のほかのメンバーの分が外れる。
- Team を細かく分けた運用で「Project を 1 つ管理するだけで Project なしの工数を見られる」ことが問題になったら、
  Team 単位の工数管理 role を別に設ける判断を新しい ADR で行う。
- 更新した文書: `docs/time-tracking.md`、`docs/guide/member.md`、`docs/guide/pm.md`。
