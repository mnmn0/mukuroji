# 0101. AI の月次利用量を AI table の月ごとの counter row で数え、全体停止を runtime control の任意 field で持つ

- 状態: 提案
- 日付: 2026-11-25
- 関連: Issue #414、ADR 0029（deploy 時の任意 module）

## 背景

AI assistance（Bedrock と外部 provider）の利用量は、生成1件の詳細か CloudWatch metric でしか見られない。
上限は1分あたりの生成数と token 数だけで、月の費用を抑える手段がない。
また、AI だけを deploy 全体で止める手段もない。止めるには、runtime control で API 全体を止めるか、
forward deploy するしかなかった（`docs/ai-assistance.md` の incident 手順）。

Issue #414 で必要になったのは次の4つ。

- Workspace ごとに月の token 数と推定費用を数える。
- 管理者が、今月の利用量を task 別・member 別に見られる。
- 任意の月次上限に届いたら、新しい生成を断る。
- deploy 全体で AI だけを止められる。

## 決定

### 月次利用量の counter

- 生成の receipt を持つ AI assistance table（Workspace Search table）に、月ごとの counter row を置く。
  key は Workspace partition の次の3種類。
  - `AI_USAGE#MONTH#<YYYY-MM>#WORKSPACE`
  - `AI_USAGE#MONTH#<YYYY-MM>#TASK#<task>`
  - `AI_USAGE#MONTH#<YYYY-MM>#MEMBER#<member>`

  月は試行が終わった時刻の UTC の暦月で決める。
- 各 row は次の値を `ADD` で足す。
  - 生成数
  - 入力 token 数、出力 token 数、合計 token 数
  - 推定費用（整数の micro-USD）
  - 推定費用がない生成の数

  推定費用を整数で持つのは、浮動小数の足し算で誤差がたまらないようにするため。
  row は TTL で、月初からおよそ400日後に消える。
- provider の usage が分かった試行ごとに1回だけ数える。対象は、成功した生成と、usage が分かる失敗の両方。
- 数えるときは1つの transaction で次の2つを書く。
  - 生成 ID ごとの marker row `AI_USAGE_RECORDED#<generationId>` を、条件付き Put で書く。
  - 3つの counter を更新する。

  marker がすでにあれば何も足さないので、同じ試行を2回数えることはない。
- 数えるのは生成を確定した後で、失敗しても生成は失敗にしない。数え漏れが起きても、
  上限での停止が少し遅れるだけで済むため。
- 生成の確定 transaction（`commitGeneration`）には counter を入れない。この transaction は、
  source 認可の条件を最大96件含めると、DynamoDB の上限100件に届くため。
- 今月の利用量は、管理者向けの `GET /api/ai-assistance/usage?month=YYYY-MM` で返す。
  この endpoint は月の prefix を Query して読む。

### 月次上限

- Workspace policy に、任意の `monthlyTokenLimit`（token 数）と `monthlyCostLimitUsd`（USD、1セント単位）を足す。
- 新しい生成の予約 transaction に、今月の Workspace row への ConditionCheck を足す。
  条件は「合計 token 数が上限未満、かつ推定費用が上限未満」。
  row がまだないときは、その月の利用がないので通す。
- 条件が満たされないときは、`AiAssistanceMonthlyBudgetExceeded`（429）で断る。
- 上限は「届いたら次の予約を断る」ものとする。すでに走っている生成の分だけ超えることは受け入れる。
- 上限の80%に届いたら、利用量の画面に注意を出す。

### 全体停止

- runtime control の AppConfig document に、任意の `aiAssistance: "enabled" | "disabled"` を足す。
  `schemaVersion` は 1 のまま。
- API は、`mode` が実行を許していて、かつ `aiAssistance` が `disabled` でないときだけ、
  新しい生成を受け付ける。止まっているときは `AiAssistanceDeploymentPaused`（403）で断る。
- `mode` が fail-closed の状態では、AI もほかの機能と同じく止まる。
- AppConfig の JSON Schema validator にも同じ field を足す。

## 検討した選択肢

- **counter を生成の確定 transaction に入れる。** 数え漏れがない。ただし、source 認可の条件と合わせて
  transaction の100件上限を超えるため採らなかった。
- **DynamoDB stream の observability projection で数える。** 再試行で確実に届く。ただし、metric 専用の
  projection に table への書き込みを持たせることになる。さらに、at-least-once の配信を重複なしに数えるには、
  結局 marker row が要る。今回は API で数え、projection は metric 専用のまま残す。
- **全体停止を環境変数か CDK parameter で持つ。** 仕組みは簡単。ただし、止めるのに deploy が要り、
  incident で間に合わない。
- **AI 用に別の AppConfig profile を作る。** 既存の document を変えずに済む。ただし、polling と
  staleness の仕組みを二重に持つことになる。

## 結果

- 管理者が今月の AI 利用量と推定費用を、task 別・member 別に見られる。
- 月次上限に届くと新しい生成が断られ、AI 以外の機能はそのまま動く。
- 運用者は AppConfig の値1つで、全 Workspace の AI だけを止められる。
- 受け入れる欠点は次のとおり。
  - 生成の確定後、数える前に処理が落ちると、その試行は数えない。
  - 走っている生成の分だけ上限を超えることがある。
  - 推定費用は deploy 設定の単価から計算するので、provider の請求額とは一致しない。
- `aiAssistance` field を知らない古い server に、この field を含む document を配ると、document が
  invalid になり全体が止まる。初回 deploy 前の変更なので、今回は問題にならない。
  次にこの document に field を足すときは、先に server を deploy してから document を配る。
- 80% に届いたときの Inbox 通知は今回は作らず、利用量の画面の注意で知らせる。
- 更新した文書は `docs/ai-assistance.md`（月次利用量と kill switch の手順）、`docs/operational-readiness.md`（runtime control の document）、`docs/guide/admin.md`。
