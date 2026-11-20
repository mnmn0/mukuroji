# 0029. Software factory を deploy 時の任意 module にし、off のときは API の入口で断る

- 状態: 提案
- 日付: 2026-11-20
- 関連: Issue #632, Tracker #625, Issue #448（tenantLifecycle の任意 module）

## 背景

先行 GA は WBS 管理と進捗報告だけを対象にし、Software factory（Agent Run、Factory board、Team の agent 設定、
MCP 用の本人 token）は後で出す。これまで Software factory を止める手段がなく、GA 版でも Factory board や
agent 設定が見えて使えた。画面を隠すだけでは、API を直接呼べば Agent Run の作成や agent 用 token の発行が
できてしまう。connectors・requestEmail・tenantLifecycle は deploy 時の任意 module になっており
（`cdk/bin/stack-modules.ts`）、同じ規約に合わせたい。

## 決定

- CDK context `mukuroji:softwareFactory` を追加し、既定は off にする。context は `bin/cdk.ts` だけが読み、
  `MukurojiStack` は `softwareFactoryEnabled` Props で受ける。
- stack は API と scheduled-jobs Lambda に `SOFTWARE_FACTORY=enabled|disabled` を渡す。off のときは
  scheduled-jobs Lambda に Agent Run triage job の環境変数と IAM policy を足さず、server 側も job の一覧から外す。
  AgentRuns table と API の IAM は変えない（Work Item の削除・コメントの fence が同じ table を読むため）。
- off のとき API は、authentication より前の middleware で次の route を `503 SoftwareFactoryNotDeployed`
  （retry 不可）で断る。route の照合は Hono の router に任せ、route 本体と同じ正規化で一致させる。
  - Web: Work Item の Agent Run 履歴と報告、Team の Agent Run board・期間サマリー・release、Team の agent 設定
  - Public API: Agent Run の作成・一覧・取得・heartbeat・finish・report・resume・take-over、
    `/v1/agent-settings`、`/v1/agent-context`
  - 本人用 agent token: `/developer/me/agent-connection` と、発行・rotate（`POST`）
- 本人用 token の失効（`DELETE /developer/me/api-keys/:id`）は off でも許す。on の期間に発行された token を
  消せるようにするため。
- MCP の WBS 読み取り（`get_task` など）が使う Public API の Work Item の読み書きは off でも残す。Workspace の
  API key や連携でも使う汎用 API であり、Software factory 固有ではないため。off では本人用 token を新しく
  発行できないので、MCP を新たに接続する経路は実質なくなる。
- Web は build を分けず、`/api/auth/me` の `softwareFactoryEnabled` が `true` のときだけ入口を表示する。
  読み込み中と値がないときは表示しない。

## 検討した選択肢

- Web で隠すだけ: 変更は小さいが、API を直接呼べば Agent Run の作成や token の発行ができる。却下。
- AppConfig の runtime control で切り替える: deploy なしで切り替えられるが、Workspace の機能構成を運用中に
  変える必要はなく、triage job の IAM を外せない。任意 module の規約にも合わない。却下。
- 各 route handler の中で判定する: 認証後に判定できるが、route が増えたときに漏れやすい。入口の middleware に
  一覧を持つ方が、どの route が対象かを 1 か所で確認できる。
- Software factory 用の resource（AgentRuns table など）も off で作らない: 費用はほぼ変わらず、Work Item 側の
  fence が table を前提にしているため、変更範囲に見合わない。

## 結果

- 既定の deploy で利用者の画面に Software factory の入口が出ず、API も Agent Run 系を受け付けない。
- on にすると今と同じ機能が使える。on から off に戻しても、保存済みの Agent Run と token の row は残る。
  off の間は読めないが、本人用 token は失効できる。on の期間に発行された本人用 token は失効するまで
  Work Item の読み書きに使えるので、off に戻すときは必要に応じて失効させる。
- 新しい Software factory 用の route を足すときは `server/src/app/middleware/software-factory-middleware.ts` の
  一覧にも足す。
- 更新した文書: `cdk/README.md`、`docs/software-factory.md`、`docs/guide/`（admin、coding-agent、pm）。
