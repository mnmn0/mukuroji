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
| [0005](0005-notification-email-ses-transport.md) | 通知の Email を SES で送り、Slack と同じ配信 queue を channel ごとの sparse index で持つ | 一部を置き換え済み（0082） |
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
| [0025](0025-public-work-item-documents-read-scope.md) | Work Item に link された Document を `work-items:read` で Work Item 経由だけ読ませる | 一部を置き換え済み（0106） |
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
| [0047](0047-workspace-time-entry-categories.md) | 工数の作業区分を Workspace の tenant profile で定義し、区分は消さずに使用停止にする | 提案 |
| [0048](0048-team-time-entry-overlap-and-daily-limit-checks.md) | 工数の時間帯の重複と1日の合計を Team ごとの設定で警告または拒否する | 提案 |
| [0049](0049-member-role-assignment-cross-table-fences.md) | メンバーへの role 割り当てと Workspace role の変更を、相手側 table の条件付き書き込みで直列化する | 提案 |
| [0052](0052-personal-tokens-without-software-factory.md) | Software factory が off でも本人用 token を発行でき、MCP は Workspace profile で読む | 提案 |
| [0053](0053-reflect-work-item-completion-into-documents.md) | Work Item の完了を、宿題にした Document のチェック項目と付箋へ automation の audit worker で反映する | 提案 |
| [0054](0054-team-time-rate-card.md) | 工数の単価表を Team ごとの `TIME_RATE_CARD` row で持ち、Workspace の既定通貨を tenant profile に置く | 提案 |
| [0055](0055-team-work-item-key-prefix-change.md) | Work Item key の prefix を Team ごとに変更でき、番号は prefix をまたいで続ける | 提案 |
| [0056](0056-web-custom-domain-cdk-context.md) | 独自 domain を `cdk.json` の CDK context で受け、synth 時に distribution・DNS・正規 URL を決める | 提案 |
| [0057](0057-app-version-is-deployed-commit.md) | アプリ全体の version は deploy した commit とし、変更履歴は deploy ごとの比較 link で残す | 提案 |
| [0058](0058-team-project-shared-work-calendars.md) | Team・Project の稼働カレンダーを tenant administration table の Workspace partition に置き、Work Item は共有カレンダーの写しを持って変更時に書き換える | 提案 |
| [0059](0059-cycle-schedule-baselines.md) | Cycle ごとの名前付き schedule baseline を、一覧の行と baseline ごとの行で Planning table に置く | 提案 |
| [0060](0060-project-default-task-view.md) | Project の既定ビューを、その Project の管理者だけが設定できる共有の既定として持つ | 提案 |
| [0061](0061-agent-token-usage-over-otlp.md) | Coding agent のトークン使用量を OTLP/HTTP JSON で受け取り、読み取り時に時刻で Run に割り当てる | 提案 |
| [0062](0062-analytics-project-report-visibility.md) | Analytics report の共有範囲に Project を足し、Team と Project の組で読み書きを判定する | 提案 |
| [0063](0063-planning-milestone-watcher-key.md) | Milestone の watcher を Collaboration table の `planning-entity` namespace に置き、通知の再確認は注入した reader で行う | 提案 |
| [0064](0064-analytics-recipient-delivery-index.md) | Analytics の定期配信を受信者ごとの索引行で持ち、「自分への配信」を 1 回の Query で読む | 提案 |
| [0065](0065-project-budget-report-and-evm.md) | Project の予算レポートと EVM を baseline・進捗・工数から都度計算し、予算を Team と Project の組で保存する | 提案 |
| [0066](0066-inbox-digest-scheduled-job.md) | Update の受信トレイ・ダイジェストを共有の scheduled-jobs Lambda で15分おきに配る | 提案 |
| [0067](0067-owner-managed-system-administrator-group.md) | system administrator の付与・解除を owner が画面から行い、Cognito group を正本のまま使う | 提案 |
| [0068](0068-workspace-workload-across-teams.md) | 要員の負荷を Workspace の全 Team の record を合算して見せ、詳細は Team ごとの可視性で絞る | 提案 |
| [0069](0069-team-portfolio-snapshot-row.md) | Workspace のポートフォリオを Team ごとに読み、月次 snapshot を Team と月ごとの Planning row で持つ | 提案 |
| [0070](0070-planning-scoped-reads.md) | Planning を Team / Project / Portfolio 単位で読み、key 設計は変えずに link と Work Item だけを絞る | 提案 |
| [0071](0071-view-export-and-sliced-import.md) | 表示中の view の書き出しはブラウザで作り、大きな import は worker が時間で区切って次の message に引き継ぐ | 提案 |
| [0072](0072-project-status-report-share-links.md) | Project の進捗レポートを snapshot として保存し、token 付きの read-only リンクで社外に共有する | 提案 |
| [0073](0073-team-health-updates-and-reviewer-acknowledgement.md) | Team を health update の対象にし、確認者の「確認済み」を update version ごとの marker 付きコメントで記録する | 提案 |
| [0078](0078-change-request-approval-applies-schedule-and-baseline.md) | 変更要求の承認は、日程の連鎖とベースラインの差し替えを既存の API で順に行い、判断を最後に記録する | 提案 |
| [0080](0080-team-grant-request-receipt.md) | Team の管理操作の冪等キーを、Project Directory table の sidecar 受付行で入力に結び付ける | 提案 |
| [0074](0074-member-display-name-on-member-row.md) | メンバーの表示名を member row に保存し、本人と管理者が version 条件付きの更新で変える。SCIM の member と Cognito の `name` は変えない | 提案 |
| [0075](0075-workload-time-off-approval-and-row-retention.md) | 要員計画の休暇は承認済みだけを capacity から引き、取消済みと古い row を書き込みのたびに整理する | 提案 |
| [0076](0076-workspace-wide-time-period-close.md) | Workspace 単位の月の締めは Team ごとの締め row をまとめて作る | 提案 |
| [0077](0077-time-budget-per-period.md) | 期間ごとの予算は、期間を key に含めた別の予算 row として保存する | 提案 |
| [0081](0081-notification-web-push-transport.md) | 通知の Web Push を自前の RFC 8291 暗号化と VAPID で送り、Email と同じ配信 queue に push channel を足す | 提案 |
| [0082](0082-notification-email-digest-and-feedback.md) | 通知 Email の digest を配信時にまとめ、SES の bounce・complaint を EventBridge と SQS で受けて宛先を止める | 提案 |
| [0083](0083-signed-calendar-feeds.md) | カレンダーフィードを token の hash で引き、読むたびに持ち主の現在の権限で組み立てる | 提案 |
| [0084](0084-charter-owner-moves-project-update-owner.md) | Project charter の責任者変更を、charter 保存後の書き込みで Project の進捗報告の担当者へ移す | 提案 |
| [0085](0085-workflow-transition-actor-roles-and-status-requirements.md) | Workflow の遷移を実行できる役割と status ごとの必須項目を configuration に持ち、人の操作だけに許す | 提案 |
| [0086](0086-slack-destinations-and-channel-posts.md) | Slack の送信先を画面から登録し、Project・Team の channel 投稿を既存の Slack index に相乗りさせる | 提案 |
| [0087](0087-team-owned-automation-definitions.md) | Automation 定義と Request form に所有 Team を持たせ、Team manager に自 Team の分の管理を任せる | 提案 |
| [0088](0088-requester-index-and-scopeless-notifications.md) | 依頼者ごとの索引行を Request Intake table に置き、依頼者への通知を scope なしの event で届ける | 提案 |
| [0089](0089-calendar-connector-event-sync.md) | Google Calendar / Outlook の予定を既存の connector link で双方向に同期する | 提案 |
| [0090](0090-automation-due-soon-and-business-day-schedules.md) | 期限前の rule は通知用の期限 index から Work Item を選び、営業日の繰り返しは実行時に Team の稼働カレンダーで数える | 提案 |
| [0091](0091-document-version-pin-and-approval.md) | 名前付き version を TTL なしの snapshot で残し、承認は成果物の Work Item に既存の approval として作る | 提案 |
| [0092](0092-document-comment-participant-index-and-mutation-receipts.md) | Document comment の thread 参加者を index row で持ち、編集・削除の冪等性を TTL 付き receipt で持つ | 提案 |
| [0093](0093-project-deliverables-and-project-file-approval.md) | Project の成果物一覧を Work Item の閲覧判定から読み、Project file の承認を Project partition に置く | 提案 |
| [0094](0094-workspace-file-type-policy.md) | 添付できるファイル形式を contracts の catalog で持ち、Workspace は既定との差分だけを tenant profile に保存する | 提案 |
| [0095](0095-member-offboarding-and-access-expiry.md) | メンバーの利用期限を読み取り時に効かせ、毎時の job で無効化する。無効化で本人の API キーを失効する | 提案 |
| [0096](0096-member-last-sign-in-on-member-row.md) | メンバーの最終ログインを member row に version を変えずに記録し、owner と admin にだけ返す | 提案 |
| [0097](0097-org-units.md) | OrgUnit（部門）で Team を束ね、部門のロールは配下の Team scope に展開して評価する | 提案 |
| [0098](0098-team-started-work-item-index-and-board-continuation.md) | Team の started な Work Item を sparse index で引き、Factory board の上限で止まった lane を続きから読む | 提案 |
| [0099](0099-workspace-agent-defaults.md) | Workspace の Agent 既定値を AgentRunsTable の Workspace partition に1行で持ち、Team 設定の読み取り時に重ねる | 提案 |
| [0100](0100-completion-gate-manager-override.md) | 完了 Gate の override は Work Item の manager だけが Web の更新で理由付きで行い、更新の監査と活動履歴に残す | 提案 |
| [0101](0101-ai-assistance-monthly-usage-and-deployment-switch.md) | AI の月次利用量を AI table の月ごとの counter row で数え、全体停止を runtime control の任意 field で持つ | 提案 |
| [0102](0102-retire-mail-and-storage-connector-providers.md) | Gmail・Outlook・Google Drive・OneDrive・Dropbox を connector の選択肢から外す | 提案 |
| [0103](0103-verify-reported-pull-requests.md) | agent が報告した pull request を Workspace の connector で照会し、状態を保存する | 提案 |
| [0104](0104-project-expense-entries.md) | Project の経費を Planning table に1件1行で保存し、申請者以外の Project manager の承認で予算の実績に入れる | 提案 |
| [0105](0105-project-budget-threshold-alerts.md) | Project 予算の消化率を毎日1回調べ、通知の閾値に達した予算ごとに1回だけ通知と Automation trigger を出す | 提案 |
| [0106](0106-public-workspace-documents-markdown.md) | Workspace の Document を Public API と MCP で Markdown として一覧・作成・更新し、scope は既存の `work-items:read` / `work-items:write` を使う | 提案 |
| [0107](0107-planning-public-api.md) | Planning の Public API は `work-items:read` / `work-items:write` で受け、権限判定は Web の `planning.read` / `planning.write` と同じにする | 提案 |
| [0108](0108-analytics-agent-usage-metrics.md) | Analytics の `agent-tokens` / `agent-cost` は query のたびに終了済み Run と usage 行を読み、費用を見られる Team を snapshot の scope に固定する | 提案 |
| [0109](0109-work-item-web-links-in-planning-table.md) | Work Item の URL リンクを Planning table の 1 row に置き、Public API と MCP から work-items scope で読み書きする | 提案 |
| [0110](0110-analytics-earned-value-metrics.md) | Analytics の EVM（SPI / CPI / EAC）は query のたびに管理する Project の予算レポートの値を読み、その Project の集合を snapshot の scope に固定する | 提案 |
| [0113](0113-slack-channel-ingest.md) | Slack の channel の発言を社内 Slack app の Events API で受け、Team / Project に対応づけて保存する | 提案 |
| [0114](0114-project-decision-log.md) | 意思決定ログを Planning table の1決定1行で持ち、Team の一覧は読み取り時に Project をまたいで集める | 提案 |
| [0119](0119-agent-cost-in-project-budgets.md) | coding agent の推定費用は USD のまま Project 予算レポートに出し、USD の予算だけ実績・閾値通知・EVM に足すかを Workspace 設定で選ぶ | 提案 |
