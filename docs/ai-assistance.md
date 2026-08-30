# AI assistance operations

Mukuroji の AI assistance は Mastra から Amazon Bedrock Runtime の Converse API を同期呼び出しし、
生成結果を人が確認する draft として返します。この文書は production と local development の
認証、model allowlist、deploy gate、live evaluation の運用契約です。

## Production configuration

既定の model ID は `jp.anthropic.claude-sonnet-4-6`、Bedrock Runtime region は API Lambda と
同じ `AWS::Region` です。JP Geo inference profile は Tokyo (`ap-northeast-1`) または Osaka
(`ap-northeast-3`) からだけ呼び出せるため、既定 model ID を使う stack はそのどちらかへ
deployします。Tokyo からは Tokyo と Osaka の両方へ route されます。

CDK deploy では次の parameter を固定します。

| Parameter | Contract |
| --- | --- |
| `AiBedrockModelId` | Runtime の default と allowlist の両方に使う、現在サポートしている exact model ID。現在は `jp.anthropic.claude-sonnet-4-6` のみを許可する。 |
| `AiBedrockInputPricePerMillionTokensUsd` | deploy時にAWS公式料金表と照合した、model IDのstandard input 100万token当たりUSD。defaultは持たない。 |
| `AiBedrockOutputPricePerMillionTokensUsd` | deploy時にAWS公式料金表と照合した、model IDのstandard output 100万token当たりUSD。defaultは持たない。 |
| `AiBedrockModelArn` | API Lambda が `bedrock:InvokeModel` できる exact foundation-model / inference-profile ARN。default はなく、account と source region を確認して指定する。 |
| `AiBedrockDestinationModelArns` | Cross-Region profile が必要とする exact destination foundation-model ARN の comma-separated list。Direct foundation-model invocation だけは空にできる。 |

JP Sonnet 4.6 を Tokyo から使う例です。`<account-id>` は deploy 対象 account に置き換えます。

```text
AiBedrockModelArn=arn:aws:bedrock:ap-northeast-1:<account-id>:inference-profile/jp.anthropic.claude-sonnet-4-6
AiBedrockDestinationModelArns=arn:aws:bedrock:ap-northeast-1::foundation-model/anthropic.claude-sonnet-4-6,arn:aws:bedrock:ap-northeast-3::foundation-model/anthropic.claude-sonnet-4-6
```

Deploy 前に `GetInferenceProfile` の `inferenceProfileArn` と `models[].modelArn` を取得し、
parameter の profile ARN、destination ARN、model ID が同じ profile revision を指すことを
evidence に残します。AWS が destination set を変更した場合は推測で ARN を追加せず、取得結果を
reviewして parameter と IAM diff を同じ deploy で更新します。

CDK は API Lambda だけに次を設定します。

```text
AI_ASSISTANCE_BEDROCK_REGION=<AWS::Region>
AI_ASSISTANCE_BEDROCK_INPUT_PRICE_PER_MILLION_TOKENS_USD=<AiBedrockInputPricePerMillionTokensUsd>
AI_ASSISTANCE_BEDROCK_OUTPUT_PRICE_PER_MILLION_TOKENS_USD=<AiBedrockOutputPricePerMillionTokensUsd>
AI_ASSISTANCE_DEFAULT_MODEL_ID=<AiBedrockModelId>
AI_ASSISTANCE_ALLOWED_MODEL_IDS=<AiBedrockModelId>
AI_ASSISTANCE_TABLE_NAME=<existing WorkspaceSearchTable name>
AI_ASSISTANCE_WORKSPACE_GENERATIONS_PER_MINUTE=32
AI_ASSISTANCE_MEMBER_GENERATIONS_PER_MINUTE=4
AI_ASSISTANCE_WORKSPACE_TOKENS_PER_MINUTE=32000000
AI_ASSISTANCE_MEMBER_TOKENS_PER_MINUTE=4000000
AI_ASSISTANCE_WORST_CASE_TOKENS_PER_GENERATION=1000000
```

現在の allowlist は一つだけです。Request の `modelId` が異なる場合に IAM failureへ任せず、
application boundaryでも拒否します。AI generation record は既存 Workspace Search table の
AI専用key prefixへ保存し、同tableの `Retain`、PITR、TTL契約を再利用します。AI用の別tableや
table-wide export権限は追加しません。

### Generation item size and retention

Generation前には、redaction済みrequest、監査入力、citation、固定envelopeをJSON化したUTF-8実byte数へ、
providerの最大structured outputを1 tokenあたり64 bytesとして予約し、さらに16 KiBのstorage envelope
余白を加えます。合計が350 KiBを超える場合は `InvalidAiAssistanceRequest` としてBedrockを呼ぶ前に
拒否します。JavaScriptの文字数はbyte budgetに使いません。Attempt開始時は既存receiptをstrongly consistentに
読み、audit envelope追加後のexact itemを、Provider後はexact generation itemを、それぞれDynamoDB adapterが
UTF-8 JSON size 350 KiB以下へ再検査します。これによりDynamoDBの400 KiB hard limitには少なくとも50 KiBの
attribute encoding余白を残します。Attempt itemが上限を超えた場合もBedrockは呼ばず、receiptをsafeな
persistence failureとしてterminalにします。

Generation作成時の `expiresAt` とDynamoDB TTLは、その時点のWorkspace policyから計算したimmutableな
deadlineです。一方、generation readとdecision/replayの公開期限は毎回strongly consistentに読んだ現在policyを
使い、`min(stored expiresAt, createdAt + current retentionDays)` として計算します。Policyを短縮した時点で
この論理期限を過ぎたdraft/citationは `retention-expired` として即時withholdし、decisionも新規保存しません。

Provider完了後にもpolicyとmember preferenceをstrongly consistentに再読し、無効化・opt-out・revision変更があれば
出力を破棄します。Generation作成はsource authorization token、policy revision、member preference revisionを同じ
commit fenceへ持ち込み、sourceを直前に再確認したうえで保存します。Decisionも最新policy revision、member preference
revision、effective期限を同じCAS境界へbindするため、再読直後の設定変更も古い出力やdecisionを保存できません。
Feedbackも書き込み直前のcommit時刻をeffective期限へbindし、対象generationの期限がその時刻を過ぎている場合は
DynamoDB transactionのgeneration condition checkで拒否します。

Policy更新時のtable scan、TTL rewrite、同期delete、backup purgeは行いません。DynamoDB TTL削除は非同期なので、
論理期限後も元rowが物理的に残る期間があります。また、短縮後にpolicyを再延長した場合、まだTTL削除されて
いないrowはimmutableなstored deadlineまで再び現在policyの対象になり得ます。不可逆な短縮が必要な運用では、
別途review済みpurge/backfillを実施する必要があります。PITRもconfigured recovery window内の物理rowを保持し、
過去時点へ復元するとその時点のpolicy rowも復元されます。復元tableは公開前に現在policyを再適用し、AI read gateを
有効にしたまま期限超過rowを検査・必要に応じてpurgeします。PITRやTTLを物理消去の即時保証として扱いません。

Policy mutation は fresh manager authorization、active-member/version fence、必要な Enterprise CONTROL revision、
revision-fenced policy CAS を含む DynamoDB transaction で、既存の Workspace Audit table へ
`ai-assistance.policy.updated` event と同時に append されます。event には workspace policy の before/after、actor、
request fingerprint、revision、retention-derived TTL だけを保存し、prompt、source、model output、credential は保存
しません。transaction response が失われた場合も policy revision と deterministic event ID を強整合で再確認し、同じ
request の再送で安全に replay できます。

### Prompt privacy and member aliases

Source resolverはworkflowごとにdirectory projectionを最小化します。Summaryにはdirectoryを付けず、Planningは
workflow status中心、TriageとSearchもmemberについてはcanonical IDだけを含め、active memberのdisplay nameを
directory promptへ直接入れません。Structured output候補は先頭100 memberまでですが、privacy aliasとdisplay nameの
重複判定は現在activeなmember全体（上限1,000）から作ります。上限を超えて安全に列挙できない場合はProviderを呼ばず
fail closedにします。このため101件目以降の名前もmaskされ、100件境界をまたぐ同名memberを一意として復元しません。

Member IDと、source/query中に現れる現在activeなdisplay nameはresolver passごとに暗号学的乱数で作る、世代間で
linkできないstrict ASCII aliasへ置換します。Aliasはmember間で一意かつcanonical IDと非衝突でなければ拒否し、mappingは
そのrequestのmemory内だけに保持します。Search/Triageのstructured output allowlistにもaliasだけを渡します。Exact
identifier alias、credential/PII redaction、field-aware maskは、文字列・JSON excerptの文字数制限より先に全文へ適用し、
境界で分割されたemail、member名、token断片が残らない順序に固定します。

Request Intakeはimmutable form snapshotのfield ID、localized label、field typeを使い、email、氏名、電話、住所fieldの
回答を元のscalar型にかかわらずserialization前にdeterministic markerへ置換し、配列もraw leafを残しません。その他のshort/long textは業務文脈を丸ごと捨てず、既存の
credential/email redactionに加えて、label付き氏名、一般的な電話番号、郵便住所patternを送信前にmaskします。同じ
redactorをsource prompt、operator guidance/query、citation、model生成prose、uncertaintyへ適用します。HTTP(S) URLおよび
プロトコル相対URLに含まれるpresigned URLの署名、credential、security token query値（AWS/GCSの代表的な形式を含む）も値ごとmaskし、
署名付きURLのbearer materialをProviderやattempt auditへ残しません。

Work Item custom fieldは、現在閲覧可能な全Team configurationを上限による切捨て前に分類します。`person`型と、field
ID/nameがemail、氏名、電話、住所を表すfieldはsensitiveとし、同じfield IDが一つのTeamでsensitiveなら全Teamで
fail closedにします。Sensitive fieldはdefault、option、validationを含むdefinition全体をdirectory promptから除外し、
structured output allowlistにも入れません。Source Work Itemからはsource Teamの現在configurationに存在する既知の
non-sensitive fieldだけを投影し、unknown/legacy fieldとsensitive fieldの値は型を推測せず省略します。これによりnumber
型の電話値もProvider/attempt auditへ到達せず、Project budgetなど非sensitiveな業務数値は保持されます。

Modelが所有するSummary/Planningのrow IDは公開・保存前にsectionとindexだけからなるserver IDへ全件上書きします。
Searchの`date.from`/`date.to`はcalendar-validな`YYYY-MM-DD`だけを受理します。その他のnon-prose stringはenum、現在の
canonical allowlist、server citation ID、またはserver-owned endpointに限定し、任意文字列はproseとしてredaction対象に
します。Provider raw outputやinvalid output本文はattempt auditへ保存せず、safeなfailure category/codeと取得済みusageだけを
finalizeします。

Providerとattempt auditへ渡すrequest/context/citation、成功generationに保存する再認可用requestはalias/mask済みの
値だけです。Modelが返したaliasはalias allowlistで検証し、source revision・permission・member directory revisionの
current authorization recheckが成功した後だけ、structured member IDと一意なdisplay nameをUI-facing draftへ復元します。
同じdisplay nameを複数memberが共有して識別できない場合は復元せず `[REDACTED_PERSON]` に倒します。
HTTPの `X-Request-Id` / `X-Correlation-Id` はAI Provider traceや監査へ転用せず、AI application traceはserver UUIDとして
生成します。

## Durable generation budget

新しい `Idempotency-Key` を受理するときは、generation receipt と、Workspace/memberそれぞれの
UTC 1分固定窓counterを、既存Workspace Search tableの一つのDynamoDB transactionで更新します。
どちらかのscopeで generation件数またはworst-case token予約が上限を超える場合は、source resolverや
Bedrock Runtimeを呼ぶ前に `AiAssistanceRateLimitExceeded` (`429`) を返します。Transaction cancellation
reasonをreceipt、Workspace counter、member counterのindexごとに判定できない場合は、上限超過と推測せず
persistence failureとしてfail closedにします。

既定値は1 keyあたり1,000,000 input-plus-output tokenを保守的に予約し、1分あたりmemberは4 key /
4,000,000 token、Workspaceは32 key / 32,000,000 tokenです。すべてpositive safe integerとして起動時に
検証し、member上限はWorkspace上限以下、1 key予約はmember token上限以下でなければ起動しません。
成功済みまたは処理中の同一keyはreceiptを優先してreplay/pendingとして扱い、現在の窓が満杯でもcounterを
再加算しません。Resolver/provider/persistence failureでも窓内counterを減算しないため、障害時は課金側へ
安全に倒れます。

ReceiptはBedrock呼び出し直前に、generation ID、Workspace/member、task、exact model ID、prompt version、
application trace、開始時刻と、実際にProviderへ渡すrequest、permission-filtered source context、citationの
bounded audit envelopeを一つのattemptへCAS更新します。Request/context/citationはsecret・直接識別子をredactし、
private member ID/display nameはrequest-local random aliasへ置換した後の値だけを保存します。Aliasとcanonical IDの
mappingや乱数seedはProvider、audit、generation rowへ保存しません。DynamoDB adapterも書込前に
同じredactionとstrict schemaを再適用します。Attemptは独立したTTLを持たず、親receiptのimmutable `expiresAt` で
成功・失敗とも同じretention deadlineまで保持されます。Authorization snapshot、raw `Idempotency-Key`、Providerの
error message/causeやcredentialはattemptへ保存しません。

Provider完了後は同じreceiptを成功または失敗へfinalizeし、終了時刻、latency、safeなstable failure category/code、
provider trace、token usageとreview済み単価によるcostを取得できた範囲で保存します。Providerがusageを返す前に
timeout/invalid outputとなった場合は、推測token/costを記録せず `provider-did-not-report` と明示します。Generation
rowの永続化に失敗した場合も、provider resultが返っていればそのusage/costを失敗attemptに残し、開始前に保存した
request/context/citationはreceiptのTTLまで監査できます。

Failed receiptは削除せずretention deadlineまでterminalに保持します。同じ `Idempotency-Key` と同じinputの
再送は保存済みsafe failureを返し、providerを再実行せずcounterも再加算しません。原因を修正して意図的に
再試行するclientは新しい `Idempotency-Key` を使い、新しいattemptとbudget reservationとして計上します。
Provider開始済みattemptはlease expiryだけでtakeoverせず、重複した有料呼び出しへ安全側に倒します。

独立したin-flight semaphoreは設けません。12秒provider timeoutと1分固定窓の件数/token capにより、
一つの窓で開始できる有料呼び出しはmember 4件、Workspace 32件に有限化されます。窓境界では直前の窓の
呼び出しが残り得るため、運用上の瞬間上限は最大2窓分としてcapacityを見積もります。

Token price parameterはmodel/profile、service tier、source/destination regionと同じdeploy evidenceで
[AWS公式料金表](https://aws.amazon.com/bedrock/pricing/)へ照合します。RuntimeはBedrockが返すinput/output
token数とこのreview済み単価から推定costをgeneration recordへ保存します。片方だけ、0、負数、非数値は
provider生成前に設定エラーとなります。Prompt cachingは使わないためcache token単価はこの見積りに含めません。

## IAM and authentication

Production は Lambda execution role の短期credentialをAWS SDK default credential chainから
取得し、SigV4でBedrock Runtimeへ送ります。Access key、secret key、Bedrock API keyをLambda
environment、CloudFormation parameter、Secrets Manager、repositoryへ追加しません。
`AWS_BEARER_TOKEN_BEDROCK` は provider のSigV4より優先されるため、production/localのどちらにも
設定禁止です。CDK templateにもこの変数をbindしません。

API roleの許可actionは非streaming Converseに必要な `bedrock:InvokeModel` だけです。
`bedrock:InvokeModelWithResponseStream`、`bedrock:InvokeModel*`、wildcard resourceは許可しません。
Primary statementは `AiBedrockModelArn` のexact ARNだけを対象にします。Destination listが空でない
場合だけ二つ目のstatementを作り、exact foundation-model ARNと
`bedrock:InferenceProfileArn = AiBedrockModelArn` の条件を同時に要求します。

Anthropic modelを初めて使うaccountでは、deploy前にBedrock model access、Marketplace prerequisites、
必要なFTU手続きが完了していることも確認します。

## Local development

Local development は個人access keyを `.env` へ保存せず、AWS IAM Identity Centerまたはreview済みの
assume-role profileを使います。

```sh
aws sso login --profile <development-profile>
export AWS_PROFILE=<development-profile>
export AWS_REGION=ap-northeast-1
export AI_ASSISTANCE_BEDROCK_REGION=ap-northeast-1
export AI_ASSISTANCE_BEDROCK_INPUT_PRICE_PER_MILLION_TOKENS_USD=<reviewed-input-price>
export AI_ASSISTANCE_BEDROCK_OUTPUT_PRICE_PER_MILLION_TOKENS_USD=<reviewed-output-price>
export AI_ASSISTANCE_DEFAULT_MODEL_ID=jp.anthropic.claude-sonnet-4-6
export AI_ASSISTANCE_ALLOWED_MODEL_IDS=jp.anthropic.claude-sonnet-4-6
export AI_ASSISTANCE_TABLE_NAME=mukuroji-workspace-search-local
export AI_ASSISTANCE_WORKSPACE_GENERATIONS_PER_MINUTE=32
export AI_ASSISTANCE_MEMBER_GENERATIONS_PER_MINUTE=4
export AI_ASSISTANCE_WORKSPACE_TOKENS_PER_MINUTE=32000000
export AI_ASSISTANCE_MEMBER_TOKENS_PER_MINUTE=4000000
export AI_ASSISTANCE_WORST_CASE_TOKENS_PER_GENERATION=1000000
unset AWS_BEARER_TOKEN_BEDROCK
bun run server:dev
```

Local principalにもproductionと同じexact profile/destination ARN boundaryを適用します。通常のunit testは
Mastra実行境界へ決定的なrunnerを注入し、AWS network、credential、課金modelを呼びません。

## Timeout and live evaluation

同期生成の通常budgetは10–12秒です。API Lambda timeoutはtransport overheadとcold startを含めた
20秒とし、p95 12秒のSLO/alarmは緩和しません。20秒に近づく継続的な呼び出しはtimeout延長ではなく、
prompt/context量、retry、model latencyを調査します。現在はstreaming権限を付与しません。

PR/CIでは、AWS credentialやnetworkを使わないsanitized baselineを実行します。

```sh
bun run ai-assistance:eval
```

このoffline evalは、`offline-input-dataset.ts` のversioned sanitized request、authorization済みcontext、
citation、allowlistをproductionと同じprompt builderへ渡します。Mastra runnerだけを決定的なrecordingへ
差し替えるため、AWS credential、network、課金modelを一切使わずに、production gatewayのsystem
instruction、prompt serialization、strict structured-output parser、redactor、usage/cost計算を通します。
recorded structured outputとprovider counterは入力datasetとは独立した`outputRevision`で管理します。

Dataset provenanceはexact model/inference-profile ID、prompt version、public schema version、dataset/output
revision、review済みprice-card revisionを固定します。System instructionとcaseごとのserialized promptは
review済みSHA-256に一致しなければfailし、4 workflowのschema、evidence-bearing claimのcitation coverage、
unknown citation/allowlist value、入力・出力の機密canary、Search filter期待値、required quality phrase、
input/output token、latency、推定cost budgetもfail-closedで判定します。出力artifactにはprompt、authorized
context、request、citation excerpt、生成本文を含めず、content-free provenance、case ID、failure code、
集計metricだけを残します。

### Offline baselineの更新手順

1. `offline-input-dataset.ts`にはsynthetic identifierとredaction済み本文だけを追加し、tenant data、実在member、
   credentialを持ち込まない。production redactorで変化する入力は`input-not-sanitized`で失敗させる。
2. Model/profile、prompt、schema、price cardを変える場合は、対応するprovenanceとdataset revisionを更新する。
   Recorded outputを更新する場合は`outputRevision`も独立して更新し、revisionの使い回しをしない。
3. 通常CIとは分離したreview済みlive evaluationから、sanitized strict outputとinput/output token、latencyだけを
   `offline-baseline.ts`へ転記する。Offline command自身にはrecordingやAWS呼び出しを追加しない。
4. Production prompt/system instructionのdiffをreviewしてから、本文を表示しない次のcommandでcandidate digestを
   算出し、datasetのreviewed digestを更新する。Digestだけの更新でprompt diff reviewを代替しない。

   ```sh
   bun server/scripts/ai-assistance/evaluate-ai-assistance.ts --review-digests
   ```

5. `bun test server/scripts/ai-assistance/evaluate-ai-assistance.test.ts`と`bun run ai-assistance:eval`を実行し、
   content-free report、quality/safety/cost budget、全caseの`promptDigestMatched: true`を確認する。期待値やbudgetを
   緩める変更もmodel/prompt/schema変更と同じreview対象にする。

実Bedrock evaluationは通常のPR/CI testから分離し、scheduledまたはoperatorが明示したmanual jobで
実行します。評価jobは次を固定します。

- reviewed dataset revision、exact model ID/profile ARN、prompt/schema revision、application commit SHA
- AWS account、source region、destination profile inventory、開始/終了時刻
- schema validation率、grounding/citation、tool error、latency、input/output token、推定cost
- max case数、max token、max cost、timeout、失敗時の停止条件

結果はPIIやprompt本文を含まない集計とsample locatorだけをrelease evidenceへ保存します。Model変更は
scheduled evalの比較結果、IAM/parameter diff、cost/latency reviewが揃うまでproduction allowlistへ
追加しません。

AWS一次情報:

- [Claude Sonnet 4.6 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4-6.html)
- [Inference profile IAM prerequisites](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html)
- [Supported inference-profile Regions and models](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html)
- [AWS SDK for JavaScript credential chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)
