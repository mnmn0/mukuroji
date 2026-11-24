# 0087. Automation 定義と Request form に所有 Team を持たせ、Team manager に自 Team の分の管理を任せる

- 状態: 提案
- 日付: 2026-11-24
- 関連: Issue #392、ADR 0028

## 背景

Automation の rule・template・recurring Work の作成・変更と実行の再試行、Request form の管理は、
これまで Workspace の owner / admin だけができた。Project と Team が増えると、各 PM が自分の Team の
定例タスク（週報の作成、月次の締め）やテンプレート、依頼フォームを持ちたくなり、変更のたびに
Workspace の管理者を経由することになる。一方で Triage の設定はすでに Team manager に任せている。

Team に任せる以上、Team の定義が他の Team の Work Item を変えたり、Workspace の secret や外部
endpoint を使ったりできてはならない。既存の Workspace 全体の定義は今までどおり動き続ける必要がある。

## 決定

- `AutomationRule`、`AutomationTemplate`、`RecurringWork` に任意の `ownerTeamId` を足す。省略は
  Workspace 全体の定義で、今までどおり Workspace 管理者だけが管理する。保存済みの定義は省略として
  読むので、移行は要らない。`ownerTeamId` は作成時にだけ決め、更新では変えられない。
  Request form はもともと `scope`（`workspace` / `team`）を持つので、それを所有 Team として使う。
- Team の定義を管理できるのは、Workspace 管理者と、その Team の **Team manager**。Team manager は、
  Workspace の業務データを書けて、Team の全 active Project の manager である member とする。Team の
  定義は Team の全 Work Item に働くため、一部の Project の manager では足りないとした。
- Enterprise の role を持つ member は、今までどおり route の `automation.manage` / `requests.manage`
  を Workspace で持つ必要がある。Team scope の Enterprise grant による委任は今回入れない。
- Team rule は保存時に次を拒否する（`403 AutomationTeamScopeViolation`）: form・inbound webhook の
  trigger、outbound webhook の action（どちらも Workspace の endpoint と secret を使う）、他の Team を
  見る Work Item Type trigger、他の Team に作る create action、他の Team の Project への move / create / update、
  他の Team の template や他の Team に作る template の参照。Team template は同じ Team の rule・
  recurring Work・適用だけが使え、Team recurring Work の `teamId` は所有 Team と同じにする。
- 実行時にも同じ境界を守る。rule の実行開始時に `ownerTeamId` を execution に固定し、
  Team rule は所有 Team の Work Item の event でだけ動く（schedule trigger は Team を持たないので
  除く）。action は event の Work Item が別の Team なら、create は作り先が別の Team なら、webhook は
  常に失敗にする（再試行しない 403）。
- 呼び出し元が管理できる範囲を `GET /api/automation/management-scopes` で返し、Web は Team の設定に
  「Team のオートメーション」を出して、選んだ Team が所有する定義と実行履歴だけを表示・作成する。
  Workspace 管理者は Workspace の設定で全 Team の定義を一覧・停止でき、カードに所有 Team を出す。

## 検討した選択肢

- 選択肢 A: 既存の `RecurringWork.teamId` などから所有 Team を推定する。field は増えないが、
  admin が作った既存の定義が突然 Team manager から変えられるようになり、「Workspace 全体の定義は
  admin だけ」を守れない。
- 選択肢 B: Team manager を「Team のどれかの Project の manager」にする（通知日数などと同じ）。
  緩すぎて、管理していない Project の Work Item を変える rule を作れてしまう。
- 選択肢 C: Team 用の route（`/api/teams/:teamId/automation/...`）を別に作り、Enterprise の Team
  scope grant も効かせる。既存 route をほぼ複製することになり、一覧の Team 絞り込みも全面に要る。
  Enterprise の委任は需要が出てから足す。

## 結果

- PM が自分の Team の定例作業・rule・テンプレート・依頼フォームを、Workspace 管理者を待たずに持てる。
- Team rule は webhook と form を使えない。必要なら Workspace の rule として管理者が作る。
- Team の Webhook endpoint、Request form の queue・回答・添付の閲覧、template の適用は、今回も
  Workspace 管理者のまま。
- Enterprise の Team scope grant による委任が必要になったら、route の scope 評価に automation を加え、
  一覧を Team で絞る変更として新しい ADR で決める。
- 更新した文書: `docs/automation.md`、`docs/request-intake.md`、`docs/guide/admin.md`。
