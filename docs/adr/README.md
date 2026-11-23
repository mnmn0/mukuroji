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
| [0011](0011-web-custom-domain-parameters.md) | 独自 domain を CloudFormation parameter で受け、正規 URL を stack が決める | 置き換え済み（0056） |
| [0012](0012-planning-revision-work-item-counter.md) | Planning の revision を Work Item の更新と Planning の変更で数え分ける | 提案 |
| [0013](0013-data-migration-runner.md) | 保存済み row の schema 移行を、checkpoint 付きの共通 runner と専用の checkpoint table で行う | 提案 |
| [0014](0014-bind-connector-oauth-callback-to-initiator.md) | Connector の OAuth callback を、flow を開始した本人の認証済み session で完了する | 採用 |
| [0015](0015-account-cost-budget-and-allocation-tag.md) | AWS アカウント全体の月次 Budget と cost allocation tag で費用を見える化する | 提案 |
| [0016](0016-project-schedule-baseline-row.md) | Project の schedule baseline を Planning table の 1 行に保存する | 提案 |
| [0017](0017-enterprise-sso-access-token-local-verification.md) | Enterprise SSO の access token を API が JWKS で検証し、失効を API 側の record で持つ | 提案 |
| [0018](0018-team-reminder-settings-storage.md) | Team の通知日数設定を NotificationsTable の Workspace 内 partition に保存する | 提案 |
| [0020](0020-time-period-close-record.md) | 工数の月次締めを Team ごとの `TIME_CLOSE` row で持つ | 提案 |
| [0021](0021-analytics-delivery-notification-outbox.md) | Analytics の定期配信を audit outbox 経由で受信者に通知する | 提案 |
| [0022](0022-work-item-notification-due-index.md) | 期限通知の schedule を Work Items table の sparse な期限 index で読む | 提案 |
| [0023](0023-member-direct-role-assignment.md) | メンバー個人への role 割り当てを、Workspace role の代わりに評価する | 提案 |
| [0024](0024-project-raid-log-storage.md) | Project のリスク・課題・変更要求を Planning table の1登録1行で持つ | 提案 |
| [0025](0025-public-work-item-documents-read-scope.md) | Work Item に link された Document を `work-items:read` で Work Item 経由だけ読ませる | 提案 |
| [0026](0026-work-item-child-restore-guard-row.md) | 子の復元を親ごとの guard row で数え、親の archive を固定数の項目で fence する | 提案 |
| [0027](0027-time-entry-visibility-and-team-time-managers.md) | Project なしの工数を Team の工数管理者が扱い、集計は一般メンバーには本人分だけ返す | 提案 |
| [0028](0028-project-permission-team-qualified-match.md) | Project 単位の権限確認を Team と Project の組で照合し、Team を決められない旧形式の権限は効かせない | 提案 |
| [0029](0029-software-factory-deploy-switch.md) | Software factory を deploy 時の任意 module にし、off のときは API の入口で断る | 一部を置き換え済み（0052） |
| [0030](0030-weekly-report-storage-and-visibility.md) | 週報を Planning table に週ごとの行と提出版ごとの行で持ち、読む人の権限でタスクを絞る | 提案 |
| [0031](0031-data-migration-lambda-and-operator-proof.md) | Data migration を operator が起動する Lambda で実行し、実行者を presigned STS proof で確かめる | 提案 |
| [0032](0032-japanese-public-holiday-monthly-sync.md) | 日本の祝日を内閣府の CSV から月に1回取り込み、tenant administration table の共有 row に置く | 提案 |
| [0033](0033-project-id-workspace-reservation-row.md) | Project ID を Workspace ごとの予約 row で一意にし、衝突したら別の ID で作り直す | 提案 |
| [0034](0034-read-only-maintenance-mode.md) | Runtime control に `read-only` mode を足し、API の入口で HTTP method と読み取り用 POST の一覧で変更を断る | 提案 |
| [0035](0035-weekly-report-submission-reminders.md) | 週報の未提出を、工数の督促と同じ通知 schedule と projection の fence で知らせる | 提案 |
| [0036](0036-ai-external-provider-workspace-keys.md) | AI の接続先に Claude API と OpenAI を加え、API キーを Workspace ごとに KMS で暗号化して AI 用 table に置く | 提案 |
| [0037](0037-workspace-search-title-index.md) | Keyword 検索はタイトルだけを持つ sparse GSI を先に読み、本文だけの一致は従来の scan で探す | 提案 |
| [0039](0039-github-actions-oidc-deploy.md) | 本番への deploy を GitHub Actions から OIDC の role で行い、deploy の値を SSM に置く | 提案 |
| [0040](0040-xray-tracing-off-by-default.md) | X-Ray tracing を既定で止め、AI の alarm を AI 設定時だけ作る | 提案 |
| [0041](0041-document-change-signals-over-websocket.md) | Document の変更を既存の WebSocket で通知し、画面の polling を間引く | 提案 |
| [0042](0042-analytics-work-item-history-rows.md) | Analytics の履歴を Work Item ごとの圧縮済み history row で持ち、audit の entity timeline は不足分だけ読む | 提案 |
| [0043](0043-named-schedule-baselines.md) | 名前付きの複数 schedule baseline を、基準の行と baseline ごとの行に分けて Planning table に置く | 提案 |
| [0044](0044-runtime-control-switch-audit-events.md) | Runtime control の切り替えを operator script が Workspace の監査ログに開始・完了・失敗の 3 種類で書く | 提案 |
| [0045](0045-relation-events-for-automation-and-webhooks.md) | Work Item relation の event を Automation trigger と webhook の event type に使い、webhook の event type は追加していく | 提案 |
| [0049](0049-member-role-assignment-cross-table-fences.md) | メンバーへの role 割り当てと Workspace role の変更を、相手側 table の条件付き書き込みで直列化する | 提案 |
| [0052](0052-personal-tokens-without-software-factory.md) | Software factory が off でも本人用 token を発行でき、MCP は Workspace profile で読む | 提案 |
| [0053](0053-reflect-work-item-completion-into-documents.md) | Work Item の完了を、宿題にした Document のチェック項目と付箋へ automation の audit worker で反映する | 提案 |
| [0054](0054-team-time-rate-card.md) | 工数の単価表を Team ごとの `TIME_RATE_CARD` row で持ち、Workspace の既定通貨を tenant profile に置く | 提案 |
| [0056](0056-web-custom-domain-cdk-context.md) | 独自 domain を `cdk.json` の CDK context で受け、synth 時に distribution・DNS・正規 URL を決める | 提案 |
| [0057](0057-app-version-is-deployed-commit.md) | アプリ全体の version は deploy した commit とし、変更履歴は deploy ごとの比較 link で残す | 提案 |
| [0059](0059-cycle-schedule-baselines.md) | Cycle ごとの名前付き schedule baseline を、一覧の行と baseline ごとの行で Planning table に置く | 提案 |
| [0060](0060-project-default-task-view.md) | Project の既定ビューを、その Project の管理者だけが設定できる共有の既定として持つ | 提案 |
