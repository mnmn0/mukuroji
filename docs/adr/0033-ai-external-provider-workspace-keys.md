# 0033. AI の接続先に Claude API と OpenAI を加え、API キーを Workspace ごとに KMS で暗号化して AI 用 table に置く

- 状態: 提案
- 日付: 2026-11-21
- 関連: [ADR 0029](0029-software-factory-deploy-switch.md)、[docs/ai-assistance.md](../ai-assistance.md)

## 背景

AI assistance は Mastra から Amazon Bedrock Runtime だけを呼んでいた。Bedrock の model は stack の
parameter で1つに固定され、利用者は接続先を選べない。手元に Claude Platform（Claude API）の
利用枠があり、Claude API や OpenAI の model も Workspace 側で選んで使いたいという要望がある。

外部 provider は Bedrock と違い IAM で認証できず、API キーが要る。キーは秘密情報なので、
保存場所・読み出せる経路・登録できる人を決める必要がある。費用は小さく保ちたい
（Secrets Manager は secret 1つで月 $0.40）。

## 決定

- 接続先を `bedrock`、`anthropic`（Claude API）、`openai` の3つにする。Claude API と OpenAI の
  model は server の catalog に固定し（`claude-sonnet-5-5`、`claude-opus-5-5`、`claude-haiku-5-5`、
  `gpt-6.2-sol`）、model ID から接続先と token 単価を決める。Workspace policy の許可 model と
  既定 model で、Workspace の管理者がどれを使うか選ぶ。
- 外部 provider の API キーは **Workspace の管理者が provider ごとに1つ登録する**（個人ごとではない）。
  登録・差し替え・削除は `workspace.manage` を要し、revision の CAS と同じ transaction の監査
  event で記録する。API はキーを返さず、末尾4文字だけを返す。
- キーは既存の `DeveloperPlatformKey`（KMS）で envelope 暗号化し、Workspace Search table の
  AI 用 row（`AI_PROVIDER_CREDENTIAL#<provider>`）に置く。KMS の encryption context は
  `mukuroji:service=ai-assistance`、`mukuroji:purpose=provider-credential`、Workspace ID、provider で、
  API の IAM は Decrypt / GenerateDataKey をこの service と purpose に限る。データ鍵は AES-256-GCM で
  Workspace と provider を AAD に入れ、別の row へ移しても復号できない。
- 呼び出しは provider の公式 SDK（`@anthropic-ai/sdk`、`openai`）で行い、既存の Mastra gateway に
  runner として差し込む。出力の検証、予約・budget・監査・redaction の流れは Bedrock と共通にする。
  キーが無い model は budget を予約する前に `AiAssistanceProviderCredentialMissing` で断る。
- 使える外部 provider は deploy 時の parameter `AiExternalProviders`（既定 `anthropic,openai`）で決め、
  空にすると今までどおり Bedrock だけになる。

## 検討した選択肢

- Secrets Manager に Workspace × provider ごとの secret を作る: 回転や監査は揃っているが、
  secret ごとに月 $0.40 かかり Workspace 数に比例して増える。API に secret の作成・削除権限も要る。
- 個人ごとにキーを登録する: 利用者の自由度は上がるが、budget と監査の単位が Workspace と合わず、
  キーの数も増える。Shinji の判断で Workspace 管理者が1つ登録する方式にした（2026-11-21）。
- Claude を Bedrock 経由だけで使う: キー管理は不要だが、手元の Claude Platform の利用枠を使えない。
- Claude API の server 側 fallback（`fallbacks`）を使う: model が切り替わると catalog の単価で
  見積もった費用と合わなくなり、12 秒の timeout にも収まりにくいので使わない。

## 結果

- Workspace の管理者が設定画面から Claude API と OpenAI のキーを登録し、model を選べる。
- 追加費用は KMS の request 料金（1万 request あたり $0.03 程度）だけで、固定費は増えない。
  provider の token 料金はそれぞれの提供元へ直接かかる。
- 外部 provider の model を選ぶと、redaction 済みの prompt が AWS の外の提供元へ送られる。
  これは設定画面と利用者ガイドに書く。
- キーの検証は形式（接頭辞と文字種）だけで、登録時に提供元へ問い合わせない。誤ったキーは
  生成時の provider エラーとして見える。
- model catalog と単価は code に固定するため、提供元が料金や model を変えたら code を更新する。
- 更新した文書: `docs/ai-assistance.md`、`cdk/README.md`、`docs/guide/admin.md`。
