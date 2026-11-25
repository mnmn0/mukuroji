# 0100. 完了 Gate の override は Work Item の manager だけが Web の更新で理由付きで行い、更新の監査と活動履歴に残す

- 状態: 提案
- 日付: 2026-11-25
- 関連: Issue #354、ADR 0085（遷移の役割と必須項目）

## 背景

完了 Gate（`completionGate`）は、`required` の条件を満たさない Work Item の completed category への遷移を、Web・Public API・MCP・自動化・一括操作・承認の決定のどの経路でも拒否する。実際の運用では、条件の外で受け入れが済んでいる（会議で顧客が承認した、承認者が不在で代理が判断した）ために、条件を満たさないまま完了にしたい場面がある。Gate を一時的に `off` にすると Team 全体の検証が止まり、誰がなぜ外したかも Work Item に残らない。

## 決定

- Team API の Work Item 更新（`PATCH /api/teams/{teamId}/issues/{issueId}`）に任意の `completionGateOverride: { reason }` を足す。`reason` は前後の空白を除いて 1〜1,000 文字で、他の key は受け付けない。不正な値は `400 InvalidWorkItemCompletionGateOverride`。
- override を送れるのは Work Item の manager だけとする。Project に割り当てた Work Item はその Project の manager、Team の manager の直接の付与、または system administrator。Project のない Work Item は Team の manager。判定は実績日の訂正と同じ関数（`requireWorkItemManagerPermission`）で行い、満たさなければ `403 ProjectAccessDenied`。
- override は、その更新が Gate に拒否されるときだけ効く。`required` の条件を満たさない遷移を通し、通した条件の ID と理由を `completionGateOverridden` として更新に渡す。Gate が拒否しない更新（条件を満たしている、completed への遷移でない）では何も記録しない。承認の件数を transaction の条件に入れる fence は、override した遷移では付けない。
- 記録は更新と同じ transaction に入れる。監査 event `work-item.updated` の `metadata.completionGateOverride`（`reason`、`conditions`）と、Work Item の活動履歴の要約（`Completed by overriding the completion Gate (...): <reason>`）に残す。実行者は監査 event と活動履歴の actor。Work Item の row には保存しない。`completionGateOverride` は監査 view の公開 metadata に加える。
- Public API・MCP・自動化・一括操作・承認の決定は override を受け付けない。`prepareConfiguredUpdateWorkItem` は入力の `completionGateOverride` / `completionGateOverridden` を常に捨て、認可済みの呼び出し元が option で渡した理由だけを使う。`completionGateOverridden` は公開の更新 body では `400` で拒否する。
- Web はタスク詳細の「完了 Gate」に、Work Item の manager にだけ、`required` の条件を満たさない間、理由の入力欄を出す。理由を書いて完了の状態で保存すると override を送る。

## 検討した選択肢

- override 専用の endpoint を作る: 状態の変更と override を 2 回の書き込みに分けると、間に別の更新が入ったときの扱いが要る。更新に 1 field を足せば、同じ revision 条件と transaction で済む。
- agent（developer credential）にも override を許す: Gate は人の判断点を機械的に守るためのもので、ADR 0085 と同じく agent からは迂回させない。
- 理由を任意にする: 後から判断の根拠を辿れないので必須にする。
- Update Feed と Factory board に override を出す: Update Feed は Project の状況報告の feed で、Work Item の更新 event を流す仕組みがない。今回は監査と活動履歴に残すだけにし、Factory board での表示とあわせて必要になったら検討する。

## 結果

- Gate を `off` にせずに、例外の完了を Work Item ごとに残せる。
- override の監査は既存の `work-item.updated` event に入るので、監査ログの検索・export は変えずに使える。
- Team API の更新 body が 1 field 増える。Public API の契約は変わらない。
- 更新した文書: `docs/work-item-configuration.md`、`docs/guide/admin.md`、`docs/guide/pm.md`。
