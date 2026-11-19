# 用語集

コードと文書で使う主な用語です。画面での呼び名が違うものは「画面」に併記しています。詳しくは各行の文書を参照してください。

## 組織と権限

| 用語 | 意味 | 詳細 |
| --- | --- | --- |
| Workspace | tenant の単位。内部では `directoryId` / `workspaceId`。すべての table の partition key の元になる | [tenant-administration](tenant-administration.md) |
| Workspace ロール | owner / admin / member / guest | [guide/admin](guide/admin.md#権限のしくみ) |
| Team | Work Item を所有する単位。workflow・custom field・Triage・エージェント設定の範囲 | [work-items](work-items.md) |
| Team の管理者 | Workspace の owner / admin、またはその Team のいずれかの Project の manager | [guide/admin](guide/admin.md#権限のしくみ) |
| Project | Team の中で目的と期間を持つ実行単位。憲章とライフサイクル（提案中〜終結）を持つ | [planning](planning.md) |
| Project ロール | manager / member / viewer | [guide/admin](guide/admin.md#権限のしくみ) |
| Enterprise role | 組み込みロールと Custom role。permission の集合で、Workspace・Team・Project 単位で割り当てる | [enterprise-identity](enterprise-identity.md) |
| Service account | 人ではない処理用の主体。scope と最小権限のロール、期限付きの credential を持つ | [enterprise-identity](enterprise-identity.md) |
| 緊急管理者（break-glass） | SSO 障害時などに `/security/recovery` から一時的に管理アクセスを復旧できる事前登録の管理者 | [enterprise-identity](enterprise-identity.md) |

## 作業の管理

| 用語 | 意味 | 詳細 |
| --- | --- | --- |
| Work Item | タスク・課題の正本。Team が所有し、`revision` で版管理する。画面では「タスク」「Issue」 | [work-items](work-items.md) |
| Work Item key | `PT-12` のような変更されない短い参照。Workspace 内で一意。接頭辞は Team ごと | [work-items](work-items.md) |
| Work Item Type | 業務の種類。既定のワークフロー・項目・子にできる種類を持つ。組み込みは「Work Item」1種類で、Epic / Story などの固定の種類はない。画面では「業務の種類」 | [work-item-configuration](work-item-configuration.md) |
| Workflow | 状態と遷移の定義。状態は バックログ / 未着手 / 進行中 / 完了 / キャンセル のいずれかの区分に属する | [work-item-configuration](work-item-configuration.md) |
| Custom field | Workspace / Team ごとに追加する入力項目。画面では「入力スキーマ」 | [work-item-configuration](work-item-configuration.md) |
| 関係（relation） | Work Item 同士の 親 / 子、ブロック、関連、重複 | [work-items](work-items.md) |
| WBS | 親子関係で作る作業分解。Team の Issues で WBS 番号と roll-up を表示する | [work-items](work-items.md) |
| スケジュール依存関係 | FS / SS / FF / SF とリード・ラグで日程を連動させる関係。「ブロック」関係とは別 | [work-items](work-items.md) |
| 責任者 / Contributor | 責任者は1人。Contributor は手伝う人（最大20人）で、予定工数と状況を持つ | [work-items](work-items.md) |
| 受け入れ条件 | 完了の判断基準（最大20件）。agent に渡すタスクで必須にできる | [software-factory](software-factory.md) |
| Task view | 権限を考慮して保存した一覧・ボードの表示設定（個人 / Team / Workspace） | [task-views](task-views.md) |
| Collection | Team や Project をまたいで Work Item を束ねたもの。所有や公開範囲は変えない | [collections](collections.md) |

## 計画と報告

| 用語 | 意味 | 詳細 |
| --- | --- | --- |
| Planning entity | `cycle` / `milestone` / `release` / `phase` / `goal` / `initiative` / `roadmap` / `portfolio` の総称。画面では「計画」 | [planning](planning.md) |
| Cycle | 週・月などの短い反復。キャパシティと繰り越し方針を持つ | [planning](planning.md) |
| Phase / Milestone / Release | Project の中の工程、節目、リリース | [planning](planning.md) |
| Goal / Initiative / Roadmap / Portfolio | 中長期の目標（OKR を含む）、施策、ロードマップ、Project 群 | [planning](planning.md) |
| Health update | Project / Initiative の構造化された近況報告。健全性（`on-track` 順調 / `at-risk` 要注意 / `off-track` 計画外 / `unknown` 未評価）、リスク、要約、次のアクション。公開後は変更できない | [planning](planning.md) |
| 更新スケジュール | Health update の担当者・頻度・督促・エスカレーションの設定 | [planning](planning.md) |
| Update feed | Health update を読む画面と既読状態。画面では「アップデート」 | [planning](planning.md) |
| Report | Throughput・Cycle time などの指標を並べた保存レポート。スナップショットと定期配信を持つ | [analytics](analytics.md) |
| Time entry / Timesheet | 工数記録と週ごとのまとまり。下書き → 提出済み → 承認済み → ロック済み | [time-tracking](time-tracking.md) |
| Capacity | メンバーの稼働可能時間と、要員の依頼・割り当て | [capacity-planning](capacity-planning.md) |

## 受付と通知

| 用語 | 意味 | 詳細 |
| --- | --- | --- |
| Request Form / Request | 版管理された依頼フォーム（Public / ログイン必須 / Internal）と、その送信 | [request-intake](request-intake.md) |
| Triage | Team の受付キュー。フォーム・メール・Webhook・失敗した Agent Run などはここを通って Backlog に入る | [triage](triage.md) |
| Customer / Contact / Customer Request | 顧客組織、その連絡先、顧客からの要望 | `contracts/src/customers.ts` |
| Inbox | 個人宛ての通知の時系列。画面では「受信箱」。既読やアーカイブでは Focus は解消しない | [notifications](notifications.md) |
| Focus | 個人が今対応すべき未解決のシグナル（ブロッカー、期限超過、レビュー依頼など）を正本から再計算した一覧。履歴ではない | [focus](focus.md) |
| Document | ページ・Wiki・ホワイトボード・テンプレートの木構造。版と公開共有 link を持つ | [documents](documents.md) |

## 自動化と外部連携

| 用語 | 意味 | 詳細 |
| --- | --- | --- |
| Automation rule | audit event をトリガーに条件を満たしたら action を実行する、版管理されたルール | [automation](automation.md) |
| Receipt | オートメーションや受信 Webhook の実行記録。同じ event で二重に実行しないために使う | [automation](automation.md) |
| Webhook | 外部への署名付き通知（`X-Mukuroji-Signature`）と、外部からの受信 endpoint の2種類 | [public-api](public-api.md)、[automation](automation.md) |
| Public API | `/api/v1` の外部向け API。API key または OAuth `client_credentials` で認証し、scope で権限を絞る | [public-api](public-api.md) |
| Connector | GitHub・Slack・Google などとの連携の導入単位。queue と定期 poll で同期する | [public-api](public-api.md) |

## Software factory

| 用語 | 意味 | 詳細 |
| --- | --- | --- |
| Software factory | 依頼が Work Item として Ready → 実装 → 検証 → 完了 と流れ、coding agent が MCP で参加し、人は判断の場面で関わる運用 | [software-factory](software-factory.md) |
| Coding Agent MCP | coding agent から Work Item を取得・着手・報告・完了する stdio の MCP server。配布版は `mcp.mjs` | [coding-agent-mcp](coding-agent-mcp.md) |
| Ready | agent が着手してよい状態。Team の「着手可能なステータス」、ブロッカーなし、必要なら受け入れ条件あり、実行中の Run なし | [software-factory](software-factory.md) |
| Agent Run | 1つの agent instance が1つの Work Item をリースで確保した作業の単位。処理中 → 完了 / 中断 / 失敗 / 解放済み / 引き継ぎ済み | [software-factory](software-factory.md) |
| リース / 停滞 | Run が作業を確保している期限。`heartbeat` が届かず期限が切れた Run を「停滞」と表示する | [software-factory](software-factory.md) |
| Agent brief | Team・Project ごとに agent へ渡す前提知識 | [software-factory](software-factory.md) |
| Factory board | Team の Agent Run をレーン・ラインで表示する画面 | [software-factory](software-factory.md) |

## 基盤

| 用語 | 意味 | 詳細 |
| --- | --- | --- |
| Audit event | 業務データの変更ごとに同じ transaction で書く不変の記録 | [event-audit](event-audit.md) |
| Outbox | AuditEventsTable の stream。通知・Webhook・自動化の起点 | [event-audit](event-audit.md) |
| Projection | audit event から作る派生データ（受信箱、検索、Webhook 配送など） | [event-audit](event-audit.md) |
| Revision / `expectedRevision` | 楽観的排他のための版番号 | [work-items](work-items.md) |
| Idempotency-Key | 再送しても一度だけ反映するための key | [event-audit](event-audit.md) |
| Runtime control | AppConfig による API・worker の有効 / 無効スイッチ。既定は無効（fail-closed） | [operational-readiness](operational-readiness.md) |
| Floci | ローカル開発で使う AWS エミュレーター（Docker） | README |
| Restore drill | PITR からの復元を定期的に検証する訓練 | [restore-drill](restore-drill.md) |
