# 0085. Workflow の遷移を実行できる役割と status ごとの必須項目を configuration に持ち、人の操作だけに許す

- 状態: 提案
- 日付: 2026-11-24
- 関連: Issue #380、#354（完了 Gate）、ADR 0028

## 背景

「レビュー済み」「承認済み」のように人が判断する工程を workflow で表したいが、これまでの workflow は遷移元と遷移先の組しか検証しなかった。Team の Work Item 更新権限があれば、許可された遷移は誰でも実行でき、自動化・Public API・MCP の agent も同じだった。必須項目も Work Item Type 単位で、status ごとには決められなかった。

Status を変える経路は、Web の更新、Web の一括操作とその取り消し、Automation の action、Project template、Public API と MCP、Request の取り込み、承認の決定と多い。どれか一つでも検査を通らなければ、制限は回避できる。

## 決定

- `WorkflowTransition` に任意の `allowedActorRoles`（`project-manager`、`assignee`）を、`WorkflowStatusDefinition` に任意の `requiredFields`（`due-date`、`acceptance-criteria`）と `requiredCustomFieldIds` を足す。既存の configuration document に足すだけで、schema version は上げない。省略時は従来どおり何も検証しない。
- 判定は status が変わるときだけ server が行う。Work Item の作成と更新を configuration に照らす `prepareConfiguredCreateWorkItem` / `prepareConfiguredUpdateWorkItem` と、承認の決定で遷移を解決する関数に、呼び出し元の種類（人・自動化・developer credential）を必須の引数として渡す。新しい経路を足すと型検査で引数の不足が分かる。
- 役割を限った遷移は、Web から操作する人だけが実行できる。自動化と developer credential は、credential の持ち主が manager でも実行できない。`project-manager` は Work Item の Project の manager（Project のない Work Item では Team の manager）で、Project を移す更新では移す前と後の両方を要る。`assignee` は変更前の担当者で、同じ更新で自分を担当者にしても満たさない。
- 遷移の分からない変更（初期状態以外での作成、別 workflow の Type への変更）は、その status に入る transition のうち最も制限の弱いものに従う。
- 拒否は役割の不足を `403 WorkflowTransitionActorDenied`、必須項目の不足を `409 WorkflowStatusRequirementsNotMet` とし、どちらも満たされない規則の一覧を返す。Public API は既存の problem code（`forbidden` / `conflict`）に写し、規則ごとの `errors[]` を足す。MCP は remote の文言を転送せず、形式を確かめた field pointer だけを示す。

## 検討した選択肢

- 遷移の役割に任意の Workspace role・custom role を指定する: 柔軟だが、Project ごとの権限（ADR 0028）と重ねた判定が複雑になる。Issue が挙げる「Project manager のみ」「責任者のみ」は 2 つの役割で表せるので見送る。
- credential の持ち主の役割で agent も判定する: manager が発行した token の agent が「承認済み」に動かせてしまい、人の判断を表すという目的に合わない。Public API で人が使う script も同じ扱いになる欠点は受け入れ、Web から操作してもらう。
- 遷移ごとに条件式や後処理を持たせる: Issue が重い仕組みを入れないとしているので見送る。
- 担当者を必須項目に含める: 担当者はすべての Work Item で必須なので意味がなく、含めない。

## 結果

- 設定のない workflow は従来どおり動き、configuration を読み直す migration も要らない。
- Status を変える経路を足すときは、呼び出し元の種類を渡さないと型検査が通らないので、検査の抜けが起きにくい。
- 役割を限った遷移は自動化と API からは動かせないので、その遷移を自動化に任せたい Team は役割を外す必要がある。
- 状態に入るときだけ判定するので、状態に入った後に必須項目を消すことは止めない。必要になったら状態ごとの「保持する項目」を別に検討する。
- 更新した文書: `docs/work-item-configuration.md`、`docs/guide/admin.md`、`docs/guide/pm.md`、`docs/guide/coding-agent.md`。
