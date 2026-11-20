# 0022. メンバー個人への role 割り当てを、Workspace role の代わりに評価する

- 状態: 提案
- 日付: 2026-11-19
- 関連: Issue #429

## 背景

PMO や経営層には「全 Project を読めるが編集しない」権限が、監査担当には「監査 log だけ読める」権限が
要る。Enterprise の role assignment は `member` principal を型として持ち、評価器も member の
assignment を解決できたが、作る API がなく、role を付けられるのは SCIM の directory group だけだった。
Password ログインだけの小さな運用では人に role を付けられない。

評価器には既に次の規則がある。member に一致する assignment か directory mapping が1件でもあると、
legacy の Workspace role（owner / admin / member / guest）と Project membership を使わず、
assignment の和集合と `workspace.read` だけで評価する（`includeWorkspaceRolePermissions: false`、
`enterpriseLegacyProjectAccessSuppressed`）。Legacy の member role は Workspace scope で
`projects.write` を持つので、assignment と和集合にすると全 Project を編集できてしまう。

## 決定

- `POST /api/enterprise/security/role-assignments` と `DELETE .../:assignmentId` で、member 個人に
  Workspace / Team / Project scope の role を直接割り当てる。group mapping と同じ
  `security.manage` または `members.manage` を要求し、caller の permission を超える role は拒否する。
  作成・解除は `role-assignment.created|deleted` として enterprise identity の state と同じ
  transaction で監査に書く。
- 優先関係は既存の規則に合わせる。個人 assignment を持つ member は legacy role ではなく assignment だけで
  評価する。和集合にはしない。
- この規則で起きる降格・昇格を防ぐため、自分自身、owner、owner 以外が操作する admin、guest への
  guest 不可 role、owner 以外による管理系 permission を含む role の付与を API が拒否する。解除にも
  同じ制限をかける。最後の assignment を外すと legacy role と Project membership が戻るので、owner 相当
  以外の caller は、戻る権限（member の Workspace role と Project manager の permission）をすべて持つ
  場合だけ最後の1件を外せる。無効化された member も再有効化で legacy role に戻るので同じ判定をする。
  この判定は削除と同じ条件付き書き込みの中で行う。Direct assignment を
  持つ member を owner / admin に変える操作も拒否し、guest になった member の direct assignment は
  guest 可の role だけを評価する。
- メンバーに direct assignment されている custom role に管理系 permission を足す編集も owner 相当だけに
  許す。既に持つ管理系 permission を残したままの名前や説明の編集は妨げない。割り当て時は、caller が持たない
  permission と管理系 permission を含まないこと（guest には guest 可であること）を、書き込む state の role 定義で
  再確認する。解除時の管理系 role の判定も、削除する state の role 定義で行う。
- 監査 event の public metadata では member を Workspace Audit の member 仮名（`memberId`）で示し、
  member key や email を残さない。
- Built-in role に `workspace:portfolio-viewer`（全 Team・Project の読み取り）と
  `workspace:auditor`（`audit.read`）を加える。Guest には割り当てられず、assignment 後に guest へ
  変わった member では評価時に無視する。

## 検討した選択肢

- 個人 assignment を legacy role と和集合にする: Project manager が PMO role を付けても自分の Project を
  編集し続けられる。ただし legacy の member / admin role は Workspace scope で書き込み権限を持つので、
  和集合にすると全 Project を編集できる。Legacy の Project 単位の判定を enterprise の評価と
  合成し直す必要があり、範囲が大きい。
- 既定 role を custom role の雛形として作る: Workspace ごとに作成が要り、名前や permission が
  変えられて「既定」として扱えない。Built-in にして固定した。
- System administrator（Cognito group）を owner / role assignment に置き換える: Cognito group は
  CDK と運用手順（`cdk/README.md`）に結び付いており、別の判断として扱う。この ADR では変えない。

## 結果

- AWS の操作や SCIM なしで、PMO と監査担当に権限を付けられ、付与と解除が監査 log に残る。
- PMO role を付けた Project manager は、その Project も読み取りだけになる。編集が要る Project には
  Project scope の role を追加で割り当てる。利用者ガイドに明記した。
- System administrator の画面からの付与・解除は未対応のまま残る（Issue #429 に記録）。
- 昇格の拒否と割り当ての作成は別 table の書き込みで、同時に起きると両方が成功し得る。結果は
  owner / admin の権限が割り当てた role に狭まる方向だけで、権限は広がらない。owner が割り当てを
  外せば戻る。両 table をまたぐ条件付き書き込みは別の変更として扱う（Issue #429 に記録）。
- 更新した文書: `docs/enterprise-identity.md`、`docs/guide/admin.md`。
