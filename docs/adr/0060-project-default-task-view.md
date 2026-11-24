# 0060. Project の既定ビューを、その Project の管理者だけが設定できる共有の既定として持つ

- 状態: 提案
- 日付: 2026-11-22
- 関連: Issue #381

## 背景

保存したタスクビュー（task view）の既定は、個人の既定（`personal`）と Team の既定（`team`）の 2 種類だった。
Team の既定の marker は surface と scope ごとの key で持つので、Project 画面（`project` surface、Team 付きの Project scope）で
Team に公開したビューを既定にすると、実際にはその Project だけの既定になっていた。ところが API では `team` と呼ばれ、
設定できるかどうかは「その Team の管理者か、その Team のどれかの Project の管理者」で判定していた。
このため、Project A の管理者が同じ Team の Project B の既定を変えられた。

Issue #381 は「Project 単位の既定 view を設定できるようにする」ことを求めている。

## 決定

- 既定の出どころに `project` を追加する（`TaskViewDefaultSource` と `SavedTaskViewDefaultSource`）。
  `team` は Team scope だけ、`project` は Team 付きの Project scope だけに使え、合わない組み合わせは 400 にする。
- Project の既定は、これまでの Team の既定と同じ marker（owner 種別 `team`、key に surface と Project scope を含む）に保存する。
  DynamoDB の key と row の形は変えない。読み出し時に scope が Project なら出どころを `project` として返す。
- 既定の優先順位は「個人 → Team または Project → 組み込み」のままにする。1 つの scope に付く共有の既定は Team か Project のどちらか 1 つ。
- Project の既定を設定・解除できるのは、その Team 付き Project を管理できる人だけにする。
  `TaskViewAccessScope.manageableProjectScopeKeys` に `${teamId}\0${projectId}` で持ち、
  System Admin・Workspace の owner / admin（Enterprise では `workspace.manage`）は読めるすべての Project、
  Enterprise では `teams.manage`（その Team）か `projects.manage`（その Project）、通常の権限では Project の `manager` ロールで判定する。
  別の Project の管理者であることは理由にならない。
- 一覧の capability に `canSetProjectDefault` を、ビューの preference に `isProjectDefault` を追加する。
  Project scope の `canSetTeamDefault` と `isTeamDefault` は常に false になる。

## 検討した選択肢

- 選択肢 A（採用）: 既存の marker を使い、出どころの名前と権限判定だけを Project 単位にする。
  利点: 保存形式も移行も要らない。欠点: 内部の owner 種別名（`team`）と API の名前（`project`）がずれる。
- 選択肢 B: owner 種別 `project` の marker を新しく作る。
  利点: 保存形式と API の名前がそろう。欠点: 既存の marker の読み替えか移行が要り、同じ scope に 2 種類の共有の既定が並びうる。
- 選択肢 C: 何も変えず、Project 画面の Team の既定を Project の既定として案内する。
  利点: 変更がない。欠点: 別の Project の管理者が既定を変えられる問題が残る。

## 結果

- Project の既定を変えられる人が、その Project の管理者と Team の管理者に限られる。
- Project 画面のビューの操作には「この Project の既定」が出て、Team 画面の「チームの既定」とは別の表示になる。
- 既存の Team の既定が Project scope に付いていた場合は、そのまま Project の既定として扱われる（本番環境への deploy 前なので移行は不要）。
- 同じ判断で、Workspace 横断の Work Item 一覧（`work-items` surface、Workspace scope）も保存・共有できるようにした。
  共有したビューの Project・Contributor・ジョブロールの条件は、読む人が閲覧できない分を読み出し時に外す（既存の permission-redacted と同じ）。
- 利用者ガイド: `docs/guide/member.md`（Work Item 一覧）、`docs/guide/pm.md`（Project の既定ビュー）。
