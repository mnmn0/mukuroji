# アーキテクチャ概要

新しく開発に加わる人が、workspace・module・table・worker の対応と、守るべき不変条件を一通り把握するための文書です。
各項目の詳細な契約は末尾の関連文書にあります。用語は [用語集](glossary.md)、設計判断の経緯は [ADR](adr/README.md) を参照してください。

## 全体像

```text
Browser (React SPA, PWA)
   │  HTTPS (same origin)
   ▼
CloudFront ── /*      → S3 WebBucket（静的ファイル）
           └─ /api/*  → API Gateway HTTP API → ApiFunction（Hono, Lambda）
Browser ── WebSocket → API Gateway WebSocket API → RealtimeHandlerFunction

ApiFunction ── TransactWriteItems ──▶ DynamoDB（業務 table ＋ AuditEventsTable）
                                          │ AuditEventsTable stream（outbox）
                                          ▼
               CollaborationProjectionFunction（受信箱・realtime・検索・Webhook/Connector 投影）
               AutomationEventFunction（オートメーション）
                                          │
                                          ▼
               SQS（Webhook 配送 / Connector 同期）→ 各 worker Lambda
EventBridge（毎分）→ ScheduledJobsFunction（Automation・Triage・Agent Run・Slack・Analytics・通知）

Coding agent ── stdio ── MCP server（mcp.mjs）── HTTPS ──▶ Public API（/api/v1）
```

- AWS 上の CloudFormation stack は `Mukuroji` の1つだけです（`cdk/bin/cdk.ts`、`cdk/lib/stacks/mukuroji-stack.ts`）。
  stack は `cdk/lib/subsystems/*` の builder から組み立て、restore drill・connector・request email・tenant lifecycle
  などは CDK context（`-c mukuroji:<module>=true`）で有効にする任意 module です。
- Web は stack とは別に `bun run web:deploy` で WebBucket へ配置します。Web と API は CloudFront の同一 origin です。
  `WebDomainName` を指定すると同じ distribution が独自 domain でも配信し、その URL が通知の link に使う正規 URL になります。
- ローカルでは Floci（AWS エミュレーター）と `server:dev`・`workers:dev`・`web:dev` で同じ構成を再現します（README）。

## Workspace（パッケージ）の構成

Bun workspaces で、依存と lockfile はルートで管理します。

| パッケージ | 役割 | 主な技術 |
| --- | --- | --- |
| `contracts/` | Web・Server・CDK が共有する型と契約。公開面は `contracts/src/index.ts` | TypeScript、OpenAPI（`contracts/openapi/`） |
| `web/` | SPA と PWA | React 19、React Router、SWR、Tailwind CSS、Vite、Storybook |
| `server/` | API・worker・MCP server | Hono、Bun（ローカル）/ Lambda（Node.js 22）、AWS SDK v3、zod |
| `cdk/` | AWS インフラ | aws-cdk-lib、cdk-nag、jest |

依存の向きは `.dependency-cruiser.cjs` で検査します（`bun run dependencies:check`）。

- `web`・`server`・`cdk` は互いの source を import しない。共有するものは `contracts` に置く。
- `contracts` は他の workspace に依存しない。
- server の module は `domain`（純粋な TypeScript）→ `application`（use case と transaction 境界）→
  `adapter-in`（HTTP・event の入力変換）/ `adapter-out`（DynamoDB・S3 など）に分け、組み立ては `app/composition` だけで行う。
- web は `app → pages → features → entities → shared` の順にだけ依存し、各領域を `model/`・`ui/`・`api/`・`queries/`・`mutations/` に分ける。

各 workspace の規約は `AGENTS.md`（ルート、`web/`、`server/`、`contracts/`、`cdk/`）にあります。

### エントリポイント

| 対象 | ファイル | 起動 |
| --- | --- | --- |
| API | `server/src/handlers/api.handler.ts`（`app/createApp.ts` を Lambda と Bun の両方で使う） | `bun run server:dev` |
| Lambda worker | `server/src/handlers/*.ts`（CDK の `NodejsFunction` が直接 bundle） | AWS 上のみ |
| ローカル worker | `server/scripts/local-workers/run.ts` | `bun run workers:dev`（1巡だけなら `workers:once`） |
| Coding Agent MCP | `server/src/handlers/coding-agent-mcp.ts` | `bun run mcp:start`、配布版は `bun run mcp:build` で `mcp.mjs` |
| Web | `web/src/main.tsx`、ルーティングは `web/src/app/router.tsx` | `bun run web:dev` |
| CDK | `cdk/bin/cdk.ts` | `bun run cdk:synth` |

## Server の構成

```text
server/src/
├── app/             # createApp.ts（middleware の順序）、composition/（唯一の組み立て場所）
├── api/             # api-router.ts と routes/*-routes.ts、shared/（認証・認可・HTTP 共通処理）
├── handlers/        # Lambda の薄い入口。多くは runtime control の guard 付き
├── infrastructure/  # AWS client、設定、observability、runtime control（業務知識を持たない）
└── modules/<名前>/   # 業務 module（domain / application / adapter-in / adapter-out / index.ts）
```

## Module と table の対応

DynamoDB の table はすべて on-demand、PITR 有効、削除時 Retain です（`cdk/lib/subsystems/data-stores.ts`）。
key は必ず server が認証済みの主体から組み立て、client が送った値をそのまま使いません。

| Module | 持っているもの | 主な table |
| --- | --- | --- |
| `work-items` | Work Item 本体、Work Item key、workflow・custom field・type・関係グラフの設定、import | WorkItemsTable、WorkItemConfigurationTable、TeamIssueEventsTable |
| `directory` | Team、Project、Project メンバーとロール、憲章 | ProjectDirectoryTable |
| `workspace-access` | Workspace メンバー、招待、Workspace ロール | WorkspaceAccessTable |
| `planning` | Cycle・Milestone・Release・Phase・Goal・Initiative・Roadmap・Portfolio、依存、health update | PlanningTable |
| `update-feed` | アップデートのフィード、既読状態、保存フィード | PlanningTable |
| `collections` | Work Item のコレクション | PlanningTable |
| `capacity-planning` | 稼働可能時間、要員の依頼と割り当て | CapacityPlanningTable |
| `time-tracking` | 工数記録、タイムシート、予算 | AnalyticsTable（`TimeEntryTeamDateIndex`） |
| `analytics` | ダッシュボード、保存レポート、スナップショット、定期配信、予測 | AnalyticsTable |
| `automation` | ルール、テンプレート、繰り返し作業、一括操作、受信 Webhook、実行記録 | AutomationTable |
| `request-intake` | リクエストフォームと版、受付キュー | RequestIntakeTable |
| `triage` | Team の Triage、ルーティング、SLA | RequestIntakeTable |
| `customers` | 顧客、連絡先、顧客要望 | CustomersTable |
| `collaboration` | コメント、返信、ウォッチ、リアクション、メンション、audit からの投影 | WorkItemCollaborationTable、ProcessedAuditEventsTable |
| `notifications` | 受信箱、Web Push、Slack 配信 | NotificationsTable、PushSubscriptionsTable |
| `focus` | 個人のフォーカス状態、優先ルール、スヌーズ | FocusTable |
| `documents` | ページ・Wiki・ホワイトボード、版、公開共有 | DocumentsTable |
| `files` | ファイルの版・校正・承認、署名付き URL、malware scan 状態 | FileProofingTable、FileBucket（S3） |
| `workspace-search` | 検索用文書、保存ビュー（task view） | WorkspaceSearchTable |
| `ai-assistance` | Bedrock による下書き生成、冪等性、予算 | WorkspaceSearchTable |
| `agent-runs` | Agent Run のリースと報告、Team のエージェント設定 | AgentRunsTable |
| `coding-agent-mcp` | stdio の MCP server（Public API を呼ぶ client） | なし |
| `developer-platform` | API key、OAuth app、Public API、署名付き Webhook、Connector、import / export | DeveloperPlatformTable（KMS で暗号化） |
| `enterprise-identity` | SSO、SCIM 2.0、Custom role、Service account、緊急管理者、IP / MFA / session policy | EnterpriseIdentityTable |
| `tenant-administration` | テナント profile、保持・legal hold、export と閉鎖 | TenantAdministrationTable、TenantExportBucket |
| `audit` | 監査 event の書き込みと読み出し、非同期 export | AuditEventsTable、AuditExportBucket |
| `realtime` | WebSocket の ticket、接続、presence | RealtimeSessionsTable |
| `authentication` | Cognito の sign-in、MFA、パスワード変更 | Cognito User Pool、試行制限の counter は DeveloperPlatformTable（[ADR 0002](adr/0002-shared-authentication-attempt-limits.md)） |
| `restore-drill` | PITR の復元訓練（任意 module） | RestoreDrillStateTable |
| `data-integrity` | 横断的な整合性検査（読み取り専用） | 各 table を読むだけ |
| `data-migration` | 保存済み row の schema version 移行（CLI） | 対象 table と checkpoint table（AWS 上は未定義） |
| `external-chat` | Slack / Teams のスレッド同期の契約（未接続） | なし |
| `work-item-workflow`、`file-upload-policy` | workflow 定義の検証、アップロード上限（純粋な処理） | なし |

Work Item の table は `directoryTeamId`（`<workspace>#team#<teamId>`）を partition key に持ち、
Work Item は Team が所有します。他の module（planning、analytics、notifications など）は Work Item を読むだけです。

## 非同期処理（worker・queue・stream）

### DynamoDB stream

| Stream | 処理する Lambda | 内容 |
| --- | --- | --- |
| AuditEventsTable | CollaborationProjectionFunction（`audit-projection-handler.ts`） | 受信箱の通知、realtime 配信、検索への反映、Webhook 配送と Connector 同期の queue 投入 |
| AuditEventsTable | AutomationEventFunction（`automation-event-handler.ts`） | オートメーションのルール実行 |
| AuditEventsTable（INSERT） | TenantOperationFunction | 監査 event への保持期間・legal hold の適用 |
| EnterpriseIdentityTable | EnterpriseScimGroupJobFunction、EnterpriseIdentityMaintenanceFunction | SCIM group の反映、世代の整理 |
| TenantAdministrationTable | TenantOperationFunction | 保持ジョブ、テナントの export・閉鎖 |
| WorkspaceSearchTable | AiAssistanceObservabilityFunction | AI 生成の metric（内容は含めない） |

AuditEventsTable の stream が outbox を兼ねます。業務 table の更新と audit event は同じ transaction で書くので、
後続の通知・Webhook・自動化は「確定した変更」からだけ生まれます。

### SQS

| Queue | 処理する Lambda | 投入元 |
| --- | --- | --- |
| WebhookDeliveryQueue | WebhookDeliveryFunction | audit の投影（外部への署名付き Webhook） |
| WorkItemImportQueue | WorkItemImportFunction | API（import の確定） |
| AuditExportQueue | AuditExportWorkerFunction | API（監査ログの非同期 export） |
| ConnectorSyncQueue（任意） | ConnectorSyncFunction | audit の投影、Connector の定期 poll |
| Tenant*ExecutionQueue ×6（任意） | テナント操作の各 capability Lambda | TenantOperationFunction |

どの queue も専用の DLQ を持ち、最大受信回数は5回です。stream の処理失敗も DLQ に送り、黙って捨てません。

### スケジュール

EventBridge が毎分 ScheduledJobsFunction（`scheduled-jobs-handler.ts`）を起動し、その中で各 job を周期ごとに実行します。

| Job | 周期 | 内容 |
| --- | --- | --- |
| automation-schedule | 1分 | 繰り返し作業、再試行、リースの回復 |
| triage-schedule | 1分 | スヌーズ・SLA の期限が来た Triage を戻す |
| agent-run-triage | 1分 | 失敗・停滞した Agent Run を Triage に起票 |
| slack-notifications | 1分 | Slack 通知の配信 |
| analytics-schedule | 5分 | レポートの定期配信 |
| notification-schedule | 60分 | 近況の督促、期限通知、顧客データの保持 |

ほかに Connector の poll（5分、任意）と restore drill（日次で判定し90日ごとに実行、任意）があります。

ローカルの `workers:dev` は schedule・SQS・audit stream を1プロセスで再現しますが、WebSocket、SCIM stream、
テナント操作、restore drill、GuardDuty scan などは対象外です（README の「ローカルの補助サービスとworker」）。

## そのほかの AWS リソース

- **Cognito**: User Pool（自己登録なし、パスワード12文字以上、TOTP MFA）。Hosted UI と外部 IdP は stack 外で設定し、parameter で渡す。
- **S3**: FileBucket（versioning、GuardDuty malware scan。scan 結果が `NO_THREATS_FOUND` になるまで読めない）、
  import・audit export・tenant export・restore drill 用の bucket。
- **Bedrock**: AI assistance（任意）。API の role に許可したモデルだけを呼ぶ。
- **AppConfig runtime control**: API・WebSocket・worker の入口で毎回確認する enabled / disabled スイッチ。
  stack 作成直後は disabled で、運用者が enabled にする。
- **監視**: CloudWatch alarm を2つの SNS topic に通知（[`docs/operational-readiness.md`](operational-readiness.md)）。
- **KMS / Secrets Manager**: Developer platform の暗号化、文書共有 token、監査の仮名化 key など。

## 認証・認可と tenancy

### tenant の単位

tenant は **Workspace** です（内部の `directoryId` / `workspaceId`）。1つの deploy は1つの Workspace に固定され
（CDK parameter `WorkspaceDirectoryId`）、Cognito の custom attribute がそれと一致しない token は拒否します。
すべての table の partition key は Workspace から作られ、閉鎖中・閉鎖済みのテナントへの request も拒否します。

### 認証の種類

| 利用者 | credential | 入口 |
| --- | --- | --- |
| Web の利用者 | Cognito の access token（パスワード、または SSO） | `/api/*` |
| 外部システム | API key、OAuth `client_credentials` token（scope 付き） | `/api/v1/*`（Public API） |
| coding agent | 個人用 token（`work-items:read/write`、最長90日）または API key | MCP server 経由で `/api/v1/*` |
| IdP | SCIM token | `/api/scim/v2/<workspaceId>/*` |
| 自動化された処理 | Service account の token（`msa_` 始まり） | `/api/*` |
| 公開 | 署名付きのリクエストフォーム link、文書共有 link、受信 Webhook | 各公開 route |

token・secret は発行時に一度だけ表示し、後から取り出せません。Public API の実効権限は
「credential の scope」と「持ち主のロール」の積です。

### 認可

- Workspace ロール（owner / admin / member / guest）と Project ロール（manager / member / viewer）、
  Enterprise の permission（`contracts/src/enterprise-identity.ts`）で判定します。
- 判定は `server/src/api/shared/*-access.ts`（`requireWorkspaceAdministration`、`requireTeamPermission`、
  `requireProjectPermission` など）と各 module の domain policy にあります。
- client が送った user ID・ロール・Workspace・所属は信用せず、server が毎回解決します。
- 認可は HTTP の入口だけでなく、use case と transaction でも条件（membership、Project の状態など）として再確認します。

利用者向けの権限の説明は [管理者ガイド](guide/admin.md#権限のしくみ) にあります。

## 主要な不変条件

変更するときに崩してはいけない約束です。

1. **状態と監査は同時に書く。** 業務データの更新と audit event の Put を1つの `TransactWriteItems` で行う（[`event-audit.md`](event-audit.md)）。
2. **楽観的排他。** 更新は `expectedRevision` か条件式を必須にし、後勝ちで上書きしない（[`work-items.md`](work-items.md)）。
3. **冪等性。** Idempotency-Key は操作・scope・内容の fingerprint に結びつけ、同じ key で別内容の request は拒否する（[`event-audit.md`](event-audit.md)）。
4. **consumer は重複を除く。** stream・queue の処理は少なくとも1回届く前提で、処理済み記録を同じ transaction で書く（[`event-audit.md`](event-audit.md)）。
5. **オートメーションは1 action 1回。** 実行ごとに receipt を残し、同じルールの連鎖はループとして止める（[`automation.md`](automation.md)）。
6. **fail-closed。** 未知の schema version、scope の不一致、壊れた行は skip せずエラーにする（`server/AGENTS.md`）。
7. **失敗を黙って捨てない。** stream は部分失敗を報告し、不正な event は DLQ に送る（`server/AGENTS.md`）。
8. **秘密を残さない。** secret らしい値は書き込み時に `[REDACTED]` にし、log に token や本文を出さない。メンバーの公開 ID は仮名化する（[`event-audit.md`](event-audit.md)）。
9. **安全でないファイルは配らない。** malware scan が通るまでダウンロード URL を発行しない（[`file-proofing.md`](file-proofing.md)）。
10. **データは消さずに戻せるようにする。** stateful な table は PITR と Retain、ファイルは versioning。RPO 5分以内・RTO 4時間以内（[`operational-readiness.md`](operational-readiness.md)、[`restore-drill.md`](restore-drill.md)）。
11. **Agent Run はリースで守る。** 停滞は読み取り時に判定し、自動で担当を変えたり止めたりしない（[`software-factory.md`](software-factory.md)）。

## 品質ゲート

| 種類 | コマンド | CI |
| --- | --- | --- |
| lint・依存 | `bun run oxc:lint`、`bun run web:lint`、`bun run dependencies:check`、`bun run knip:check` | `static-analysis`（`oxc.yml`） |
| 型検査 | `bun run typecheck` | `strict-typecheck`（`quality.yml`） |
| unit test | `bun run server:test`、`bun run web:test`、`bun run api:contract:test` | `application-unit-tests`（`quality.yml`） |
| E2E | `bun run web:e2e` | `web-e2e`（`quality.yml`、4 shard） |
| CDK | `bun run cdk:build`、`bun run cdk:test`、`bun run cdk:nag` | `cdk-security`（`cdk.yml`） |
| 依存の脆弱性 | — | `dependency-review` |
| ローカル実行 | `bun run floci:up`、`bun run workers:once` | `local-runtime`（path filter あり） |
| 見た目 | `bun run web:visual:docker` | 未導入（[`web-quality-gates.md`](web-quality-gates.md)） |

main への merge には `static-analysis`・`strict-typecheck`・`application-unit-tests`・`web-e2e`・
`cdk-security`・`dependency-review` の6つが必須です。

## 関連文書

| 領域 | 文書 |
| --- | --- |
| Work Item・設定・表示 | [`work-items.md`](work-items.md)、[`work-item-configuration.md`](work-item-configuration.md)、[`task-views.md`](task-views.md) |
| 計画・分析・工数 | [`planning.md`](planning.md)、[`analytics.md`](analytics.md)、[`time-tracking.md`](time-tracking.md)、[`capacity-planning.md`](capacity-planning.md) |
| 共同作業・通知 | [`collaboration.md`](collaboration.md)、[`notifications.md`](notifications.md)、[`focus.md`](focus.md)、[`documents.md`](documents.md)、[`file-proofing.md`](file-proofing.md) |
| 受付 | [`request-intake.md`](request-intake.md)、[`triage.md`](triage.md)、[`collections.md`](collections.md) |
| 自動化・外部連携 | [`automation.md`](automation.md)、[`public-api.md`](public-api.md)、[`external-chat-sync.md`](external-chat-sync.md) |
| Software factory | [`software-factory.md`](software-factory.md)、[`coding-agent-mcp.md`](coding-agent-mcp.md)、[`ai-assistance.md`](ai-assistance.md) |
| ID・テナント・監査 | [`enterprise-identity.md`](enterprise-identity.md)、[`tenant-administration.md`](tenant-administration.md)、[`event-audit.md`](event-audit.md) |
| 運用 | [`operational-readiness.md`](operational-readiness.md)、[`restore-drill.md`](restore-drill.md)、[`data-integrity.md`](data-integrity.md)、[`data-migration.md`](data-migration.md) |
| Web | [`web-quality-gates.md`](web-quality-gates.md)、[`web-structure-migration.md`](web-structure-migration.md)、[`frontend-data-access.md`](frontend-data-access.md)、[`pwa.md`](pwa.md) |
