# 0111. coding agent の推定費用は Workspace 管理者・Team manager・Project manager・Run の本人に、それぞれの範囲で見せる

- 状態: 提案
- 日付: 2026-11-28
- 関連: Issue #837、[ADR 0061](0061-agent-token-usage-over-otlp.md)、[ADR 0087](0087-team-owned-automation-definitions.md)、
  [ADR 0108](0108-analytics-agent-usage-metrics.md)、[ADR 0119](0119-agent-cost-in-project-budgets.md)、
  [docs/analytics.md](../analytics.md)

## 背景

ADR 0061 と ADR 0108 は、Agent Run の推定費用を Team manager にだけ返すと決めた。Analytics の `agent-cost` は
Team の全 active Project の manager（ADR 0087）だけが数え、Work Item の Run 一覧と Factory board の集計は
Team のどこか 1 つの Project の manager なら費用を返していた。#837 で AI コストを Project 予算に入れたことで、
Project の manager はその Project の AI コストの合計を予算レポートで見られる（ADR 0119）のに、Run ごとの費用は
見られないという食い違いができた。Shinji は 2026-11-28 に「Project Manager はプロジェクト全体、チームマネージャーは
チーム全体、管理者はどのプロジェクトでも全部見られる形で、他の人は自分のものだけ見られる」と決めた。

## 決定

1. **誰がどの Run の費用を見られるか**：Run ごとに次のどれかに当たれば費用を返す。
   - Workspace 管理者（system administrator、Enterprise でない Workspace の owner と admin）：すべての Run。
   - Team manager（ADR 0087 と同じく Team の全 active Project の manager。Enterprise では `teams.manage` を持つ人）：
     その Team のすべての Run。
   - Project manager：Run の Work Item が**今**その Project にある Run（Analytics と予算レポートと同じく今の state で寄せる）。
   - それ以外の Team のメンバー：自分の agent が走らせた Run（`assigneeUserId` が本人）。
   トークン数は今どおり Work Item を見られる人に返す。
2. **判定は 1 か所**：`server/src/api/shared/agent-run-cost-access.ts` の `readAgentRunCostAccess` が Team ごとの判定を作り、
   Work Item の Run 一覧、Factory board の集計、Analytics の `agent-cost` が同じ判定を使う。合計（Run 一覧の total、
   Factory board の Project 行・Work Item 行・total）は今どおり、含まれる Run の費用が全部見えるときだけ費用を出す。
3. **Analytics の snapshot**：`agent-cost` を含む snapshot の permission scope hash には、ADR 0108 の「manager である
   Team の ID」に代えて、判定の範囲を表す key（`team:<teamId>`、`project:<teamId>\0<projectId>`、
   `member:<teamId>\0<userKey>`）を並べて加える。範囲が変わった人には、その snapshot を一覧・export で見せない。
   見られない Run は件数を warning で返し、数えられる Run がない group の値は `null` にする（ADR 0108 のまま）。
4. **変えないこと**：定期配信の runner は usage を読まない（ADR 0108）。予算レポートは Project の合計だけを出す（ADR 0119）。

この ADR は ADR 0061 と ADR 0108 の「費用を誰に見せるか」の部分を置き換える。

## 検討した選択肢

- Team manager だけに見せるまま、予算レポートの合計も Team manager だけにする：Project manager が自分の予算の実績の
  内訳を確かめられない。Shinji の方針と違う。却下。
- Run の開始時の Project で寄せる：予算レポートと Analytics が今の Project で寄せるので、同じ Run の費用が画面ごとに
  見えたり見えなかったりする。却下。
- 本人にも見せない：自分の agent の使い方を確かめる手段がなくなる。Shinji の方針と違う。却下。

## 結果

- Project manager と Run を走らせた本人が、Work Item の Run 一覧・Factory board・Analytics で費用を見られるようになる。
- 一部の Project だけの manager は、Team の他の Project の Run の費用を Run 一覧と Factory board で見られなくなる
  （これまでは見えていた）。
- 保存済みの Analytics snapshot のうち `agent-cost` を含むものは hash が変わり、作り直しが要る。まだ deploy していないので
  移行はしない。
- 1 回の判定で Team の権限を manager と viewer の 2 回まで読む。
