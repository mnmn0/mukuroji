# 0066. Update の受信トレイ・ダイジェストを共有の scheduled-jobs Lambda で15分おきに配る

- 状態: 提案
- 日付: 2026-11-23
- 関連: Issue #241、ADR 0010（Cycle を scheduled-jobs で動かす）

## 背景

Issue #241 の Update Feed（横断フィード・既読・保存フィード・手動プレビュー・受信トレイへの配信同意）は実装済みで、
配信の worker（`server/src/handlers/inbox-digest-worker-handler.ts`）も `INBOX_DIGEST_WORKER_ENABLED` が
`true` のときだけ動く形で入っていました。残っていたのは本番構成へのつなぎ込みです。
worker が期日の来たメンバーを探す `InboxDigestDueIndex` は Planning table に無く、worker を起動する schedule、
環境変数、IAM もありませんでした。

制約:

- なるべく安くする。Lambda や EventBridge rule を増やさず、table を scan しない
- scheduled-jobs Lambda の role は、すべての任意 module を有効にすると managed policy が上限の 10 個に達している
- 配信はメンバー本人の同意（既定 off）があるときだけ。閲覧権限は配信のたびに API と同じ判定で確かめ直す
- 初回 deploy（#636）より前に入れ、実 AWS でしか確かめられないことは #636 の確認項目で見る

## 決定

1. Planning table に sparse な GSI `InboxDigestDueIndex`（partition `inboxDigestShard` 文字列、sort `inboxDigestDueAt` 数値、
   projection は KEYS_ONLY）を追加する。属性を持つのは受信トレイ配信に同意したメンバーの row だけ。worker は index の
   key を読んだあと row を強整合で読み直すので、key だけを投影する。
2. worker は新しい Lambda にせず、共有の scheduled-jobs Lambda の job `inbox-digest` として15分おきに1回だけ試す。
   日次・週次の区切りは UTC 0:00 なので、区切りから15分以内に配信が始まる。失敗した受信者は worker 自身の
   checkpoint が保持して次の実行で再試行するため、dispatcher の再試行は使わない（shard の 90 秒 lease と競合しない）。
   runtime control は既存の `notification-schedule` を使う。
3. IAM は job 専用の managed policy にせず、role の inline policy（`policy: 'shared-role'`）に入れる。
   Planning は `GetItem`・`BatchGetItem`・`Query`・`PutItem`・`DeleteItem`・`ConditionCheckItem`、index は `Query` だけ。
   Notifications は `GetItem`・`PutItem`・`ConditionCheckItem`。Workspace access・Enterprise identity・tenant administration・
   Project directory・Collaboration は `GetItem`・`BatchGetItem`・`Query`・`ConditionCheckItem`、Cognito は
   `AdminGetUser`・`AdminListGroupsForUser`。`Scan` と `UpdateItem` は与えない。
4. 配信の on/off は CloudFormation parameter `InboxDigestDeliveryEnabled`（既定 `true`）で決め、環境変数
   `INBOX_DIGEST_WORKER_ENABLED` として渡す。`false` にすると同意は保存されたまま何も配らない。止める手段は
   この parameter と runtime control の2つ。
5. 配信の transaction は tenant profile が存在して active であることを条件にする（profile の無い Workspace に
   配らない既存の設計を変えない）。招待も tenant 設定の表示もしていない Workspace には profile がまだ無いため、
   受信トレイ配信の設定を保存する API が、profile の無い Workspace では Workspace の owner で profile を作ってから保存する。

## 検討した選択肢

- 専用 Lambda と専用 EventBridge rule: 配信の権限を他の job と分けられる。Lambda・rule・DLQ・alarm が増え、
  ADR 0010 で集約した方針と逆になる。費用は小さいが運用対象が増える
- job 専用の managed policy: 権限の見通しは良いが、任意 module を全部有効にした構成で role の managed policy 上限
  （10）を超える。上限の引き上げは account ごとの申請が要る
- 既定を `false` にして、deploy 後に operator が有効にする: 慎重だが、メンバーが同意しても届かない期間ができ、
  画面の説明も「運用者の有効化が必要」のままになる。同意は既定 off で、配る相手は本人が選んだ人だけなので、既定 `true` にする
- worker が profile の無い Workspace を legacy として通す: 権限を増やさずに済むが、profile が消えた Workspace と
  区別できなくなる。既存の worker は意図して profile を必須にしているので変えない

## 結果

- 追加の固定費は無い。15分おきの実行ごとに 16 shard の index Query と checkpoint の書き込みが数十回あるだけで、
  月に数 USD セントの範囲に収まる。index の属性は同意したメンバーの row だけが持つ
- role の inline policy が少し大きくなる（`cdk/test/iam-policy-quotas.suite.ts` で上限の 8 割以内を確認）
- 15分おきなので、区切りから最大15分ほど配信が遅れる
- 実 AWS での確認（transaction と IAM、受信トレイへの配信、権限を失ったメンバーに届かないこと）は #636 の確認項目で行う
- 更新した文書: `docs/planning.md`、`docs/issue-241-acceptance.md`、`docs/guide/member.md`、`cdk/README.md`、
  `docs/post-deploy-verification.md`
