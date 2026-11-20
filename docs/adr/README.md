# Architecture Decision Records（ADR）

設計判断とその理由を、後から読む人が「なぜこうなっているか」を辿れるように1判断1ファイルで残します。
`docs/*.md` の各文書は「現在の契約」を書く場所で、ADR は「その契約を選んだ時点の判断」を書く場所です。

## いつ書くか

次のどれかに当たる変更では、PR に ADR を含めます。

- workspace・module の境界や依存方向を変える
- DynamoDB の table・key 設計、queue・stream・worker の構成を追加・変更する
- 認証・認可・tenancy の仕組みを変える
- 外部サービス（AWS サービス、IdP、LLM など）を新しく採用する、またはやめる
- 一度決めたことを覆す（元の ADR は `置き換え済み` にして新しい ADR から参照する）

小さなバグ修正や、既存の判断の範囲内に収まる機能追加には不要です。

## 書き方

1. [`0000-template.md`](0000-template.md) を `NNNN-短い-kebab-case.md` としてコピーする。
   `NNNN` は既存の最大番号 + 1 の4桁です。
2. 状態は `提案` で PR を出し、マージ時に `採用` にする。
3. 採用後の ADR は書き換えません。判断が変わったら新しい ADR を作り、古い方の状態を
   `置き換え済み（NNNN）` に変えるだけにします。

## 一覧

| 番号 | タイトル | 状態 |
| --- | --- | --- |
| [0001](0001-record-architecture-decisions.md) | 設計判断を ADR として記録する | 採用 |
| [0002](0002-shared-authentication-attempt-limits.md) | 認証の試行制限を DynamoDB の共有 counter で数え、信頼できる送信元を key にする | 提案 |
| [0003](0003-agent-run-latest-record.md) | Work Item ごとの最新 Run を `agent-run-latest` row で強整合に持つ | 採用 |
| [0004](0004-public-api-caller-identity.md) | Public API の rate limit・冪等性の呼び出し元を OAuth app 単位にする | 提案 |
| [0005](0005-notification-email-ses-transport.md) | 通知の Email を SES で送り、Slack と同じ配信 queue を channel ごとの sparse index で持つ | 提案 |
| [0006](0006-finished-run-index.md) | 終了済み Run を Team と終了時刻で引く sparse index を追加する | 提案 |
| [0007](0007-member-display-preferences-storage.md) | メンバーの表示設定を project directory table の sidecar row に保存する | 提案 |
| [0008](0008-audit-stream-two-readers-and-worker-secrets.md) | AuditEvents stream の reader を 2 つに保ち、worker の secret を Secrets Manager から読む | 提案 |
| [0009](0009-directory-display-order.md) | Team と Project の表示順を sort key から切り離し、名称変更で ID を変えない | 提案 |
| [0010](0010-cycle-schedule-due-index.md) | Cycle の自動作成・自動繰り越しを既存の due index と scheduled-jobs で動かす | 提案 |
| [0011](0011-web-custom-domain-parameters.md) | 独自 domain を CloudFormation parameter で受け、正規 URL を stack が決める | 提案 |
| [0012](0012-planning-revision-work-item-counter.md) | Planning の revision を Work Item の更新と Planning の変更で数え分ける | 提案 |
| [0013](0013-data-migration-runner.md) | 保存済み row の schema 移行を、checkpoint 付きの共通 runner と専用の checkpoint table で行う | 提案 |
| [0014](0014-bind-connector-oauth-callback-to-initiator.md) | Connector の OAuth callback を、flow を開始した本人の認証済み session で完了する | 採用 |
| [0015](0015-account-cost-budget-and-allocation-tag.md) | AWS アカウント全体の月次 Budget と cost allocation tag で費用を見える化する | 提案 |
| [0016](0016-project-schedule-baseline-row.md) | Project の schedule baseline を Planning table の 1 行に保存する | 提案 |
| [0017](0017-enterprise-sso-access-token-local-verification.md) | Enterprise SSO の access token を API が JWKS で検証し、失効を API 側の record で持つ | 提案 |
| [0018](0018-team-reminder-settings-storage.md) | Team の通知日数設定を NotificationsTable の Workspace 内 partition に保存する | 提案 |
| [0021](0021-analytics-delivery-notification-outbox.md) | Analytics の定期配信を audit outbox 経由で受信者に通知する | 提案 |
| [0022](0022-work-item-notification-due-index.md) | 期限通知の schedule を Work Items table の sparse な期限 index で読む | 提案 |
| [0023](0023-member-direct-role-assignment.md) | メンバー個人への role 割り当てを、Workspace role の代わりに評価する | 提案 |
| [0024](0024-project-raid-log-storage.md) | Project のリスク・課題・変更要求を Planning table の1登録1行で持つ | 提案 |
| [0025](0025-public-work-item-documents-read-scope.md) | Work Item に link された Document を `work-items:read` で Work Item 経由だけ読ませる | 提案 |
| [0026](0026-work-item-child-restore-guard-row.md) | 子の復元を親ごとの guard row で数え、親の archive を固定数の項目で fence する | 提案 |
