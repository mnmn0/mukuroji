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

Work Itemのprovider contextはcanonical revisioned rowとPlanning/configuration fenceだけを使い、別tableの
comment/activityは含めません。現在のCollaboration/Event storeにはgeneration transactionへbindできる共通revisionが
ないため、read直後のcomment編集をatomicに検出できないためです。Document commentは既存のcomment window/row
conditionをcommit fenceへ含められるため、引き続きpermission-filtered contextとして利用します。

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

Receiptは全pre-provider recheck後に、generation ID、Workspace/member、task、exact model ID、prompt version、
application trace、admission開始時刻と、実際にProviderへ渡すrequest、permission-filtered source context、citationの
bounded audit envelopeを一つのattemptへCAS更新します。Provider runnerをinvokeした直後は、別のexact receipt CASで
`providerStartedAt`を保存します。Gatewayはこのdispatch callbackがdurableになるまでprovider resultをparse、保存、公開せず、
marker失敗時はin-flight callをabortします。Request/context/citationはsecret・直接識別子をredactし、
private member ID/display nameはrequest-local random aliasへ置換した後の値だけを保存します。Aliasとcanonical IDの
mappingや乱数seedはProvider、audit、generation rowへ保存しません。DynamoDB adapterも書込前に
同じredactionとstrict schemaを再適用します。Attemptは独立したTTLを持たず、親receiptのimmutable `expiresAt` で
成功・失敗とも同じretention deadlineまで保持されます。Authorization snapshot、raw `Idempotency-Key`、Providerの
error message/causeやcredentialはattemptへ保存しません。

Provider成功時はgeneration row作成とreceipt成功化を一つのDynamoDB transactionでcommitし、lease-expiry回復との
競合でfailed receiptとorphan generationが共存しないようにします。失敗時は同じreceiptを条件付きでfinalizeし、
終了時刻、latency、safeなstable failure category/code、provider trace、token usageとreview済み単価によるcostを
取得できた範囲で保存します。Providerがusageを返す前に
timeout/invalid outputとなった場合は、推測token/costを記録せず `provider-did-not-report` と明示します。AI SDKが
`finishReason=content-filter`を返したmodel refusalは、自由文を保存せずstable
`AiAssistanceModelRefused` / `providerOutcome=refused`としてusageとともにterminal化します。Generation
rowの永続化に失敗した場合も、provider resultが返っていればそのusage/costを失敗attemptに残し、開始前に保存した
request/context/citationはreceiptのTTLまで監査できます。

Failed receiptは削除せずretention deadlineまでterminalに保持します。同じ `Idempotency-Key` と同じinputの
再送は保存済みsafe failureを返し、providerを再実行せずcounterも再加算しません。原因を修正して意図的に
再試行するclientは新しい `Idempotency-Key` を使い、新しいattemptとbudget reservationとして計上します。
Provider開始済みattemptはlease expiryだけでtakeoverせず、重複した有料呼び出しへ安全側に倒します。Process deathで
generationもterminal receiptも残らなかったstarted attemptは、lease expiryまではin-progressを返し、expiry後は
receipt/attemptを`AiAssistanceAttemptFailed`へCASで一度だけterminal化します。この回復はProviderを呼ばず、budgetも
再加算せず、同じkeyの応答には`Idempotency-Replayed: true`を付けます。Dispatch markerのresponse-lossを含むcrash windowでは
providerのterminal outcomeを断定せず、`providerOutcome=indeterminate`と
`usageUnavailableReason=attempt-outcome-indeterminate`を保存します。Stream projectionはこれをcontent-freeな
`ProviderAttemptCount`、`ProviderFailureCount`、`UsageUnavailableCount`へ加算し、未知のlatency、token、costを0や推測値で
記録しません。Deadline超過などprovider未呼び出しが確定したterminalizationはprovider outcomeを持たず、provider metricへ
投影しないため、indeterminateなcrash recoveryと区別できます。

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

### Release gate

`Quality gates / application-unit-tests` はServer testの後に `bun run ai-assistance:eval` を明示実行します。
Offline evaluatorのexit codeが非0なら、既存required contextである`application-unit-tests`が失敗するため、
別のrequired checkを追加せずにPRとmain pushを自動で停止します。Workflowからこのstepを削除したりjob名を
変更したりする変更は、repository rulesetと同じreleaseでreviewします。

実Bedrockを使うproduction-like評価は
`.github/workflows/ai-assistance-live-eval.yml` の `production-like-live-eval` jobで、毎週月曜03:17 UTCと
default branch上のmanual dispatchにだけ実行します。Pull request code、fork、任意refをprotected credentialで
実行しません。Deploy/promotionは、offline gateに加え、対象full commit SHAと同じSHAのlive jobと後段の
`metric-evidence-approval` jobが両方成功してから進めます。新しいpush、再deploy、model/profile/pricing変更があれば、
以前のlive結果やmetric承認を再利用しません。

### Protected live-evaluation environment

GitHub Environment `ai-assistance-live-evaluation` を作り、deployment branchを`main`だけに制限します。
Manual approvalを要求する場合はreviewerを通常のdeploy actorと分離します。API base URLを含む次の設定はprotected
environmentへ登録し、repository variableへ格下げしません。

| Kind | Name | Contract |
| --- | --- | --- |
| Environment variable | `AI_ASSISTANCE_LIVE_EVAL_API_BASE_URL` | 下記checked-in allowlistのexact normalized entryと一致するproduction-like HTTPS API base URL |
| Environment variable | `AI_ASSISTANCE_LIVE_EVAL_AWS_ROLE_ARN` | 別途provisionしたsynthetic partition専用read-only OIDC roleのexact ARN |
| Environment variable | `AI_ASSISTANCE_LIVE_EVAL_AWS_REGION` | 対象Workspace Search tableのexact AWS region |
| Environment variable | `AI_ASSISTANCE_LIVE_EVAL_TABLE_NAME` | 対象Workspace Search tableのexact physical name |
| Secret | `AI_ASSISTANCE_LIVE_EVAL_EMAIL` | Synthetic evaluation operatorの非SSO email |
| Secret | `AI_ASSISTANCE_LIVE_EVAL_PASSWORD` | MFA/challengeを要求しないsynthetic operator password |
| Secret | `AI_ASSISTANCE_LIVE_EVAL_FIXTURE_JSON` | 下記のsource ID、revision、drill専用Work Itemと交互title、expected model/prompt、canary、budgetを持つfixture |

Protected variableはtarget authenticityを単独では保証しません。Evaluator内の
`REVIEWED_AI_ASSISTANCE_LIVE_API_BASE_URLS`をreviewed commitに固定し、設定されたURLをこのallowlistのexact
normalized entryへ一致させます。Approved entryはHTTPS、default port 443、DNS hostnameでなければならず、userinfo、
query、fragment、IP literal、`localhost`またはそのsubdomainを拒否します。Base URLのpathも一致対象であり、別pathを
同じoriginとして許可しません。Production既定のallowlistは意図的に空なので、初回onboardingではoperatorが確認した
exact URLをcode review付きcommitで追加してからenvironment variableを設定します。Fixtureやenvironment variableで
allowlistを拡張できず、runtime allowlist注入はlibrary単体テストだけに使います。これによりallowlist未登録、URL不一致、
不正entryはhealth/login/DynamoDB requestより前にfail closedになります。

Access token、AWS access key、Bedrock API keyはsecretへ保存しません。Credential境界となる最初の二つのjobは次のように
分離します。最初の
`commit-preflight` jobは同じprotected environmentからAPI base URLだけを読みますが、`contents: read`だけを持ち、
`id-token: write`、role/region/table variable、login/fixture secretへアクセスしません。Dependency install後、commit-only
processでunauthenticated `GET /api/health`を行い、HTTPS responseの`applicationCommitSha`とworkflowのfull
`GITHUB_SHA`が一致しなければ終了します。その後だけ`needs: commit-preflight`のprotected
`production-like-live-eval` jobを開始します。このjobもcheckout SHAを再確認し、
ここだけが`contents: read`と`id-token: write`を持ち、SHA確認後に1800秒のSTS sessionを取得します。Full CLIも
DynamoDB readやlogin requestの前に同じcommit probeを繰り返し、commit一致後だけ
`POST /api/auth/login`へemail/passwordを送り、login responseはmemory内でstrictに検証し、
10分以上24時間以下有効なBearer access tokenだけを後続requestに使います。Health不一致、login challenge、期限不一致、
malformed responseは本文を出力せずfail closedにします。Library APIは単体テスト用にaccess token注入を許しますが、
protected CLIはtoken secretを受け付けません。DynamoDB検証後のschema validationとartifact uploadではAWS credential/region
environmentを空に上書きし、OIDC actionのpost cleanupだけにcredential隔離を依存しません。
Environment protectionでmanual approvalを要求すると、GitHubのjob単位の保護によりpreflightとlive jobでそれぞれ
approvalが必要になり得ます。承認回数を減らすためにAPI targetを保護されていないrepository variableへ移しません。

OIDC roleはapplication Lambda roleやこのrepositoryのstackから暗黙に流用せず、environment ownerが別途provisionします。
Trust policyは`aud=sts.amazonaws.com`と
`sub=repo:mnmn0/mukuroji:environment:ai-assistance-live-evaluation`のexact一致だけを許可します。

```json
{
  "Effect": "Allow",
  "Principal": {
    "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com"
  },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:mnmn0/mukuroji:environment:ai-assistance-live-evaluation"
    }
  }
}
```

Permission policyは対象AI tableのexact ARNに対する`dynamodb:GetItem`だけを持ち、fixtureのsynthetic Workspace IDを
`dynamodb:LeadingKeys`でexactに固定します。Condition key欠落を許さないため`Null=false`も必須です。

```json
{
  "Effect": "Allow",
  "Action": "dynamodb:GetItem",
  "Resource": "arn:aws:dynamodb:<region>:<account-id>:table/<exact-ai-table-name>",
  "Condition": {
    "ForAllValues:StringEquals": {
      "dynamodb:LeadingKeys": ["<synthetic-workspace-id>"]
    },
    "Null": {
      "dynamodb:LeadingKeys": "false"
    }
  }
}
```

このroleへ`Scan`、`Query`、`BatchGetItem`、`DescribeTable`、任意のwrite action、wildcard resourceを追加しません。
GitHub Environmentのbranch restrictionと上記exact `sub`は両方を維持し、片方をもう片方の代用にしません。

### Synthetic fixture preparation

評価専用Workspaceとoperatorを作り、operatorをactive non-guest memberにします。Workspace policyでexact deployed
modelと4 taskを有効にし、preferenceも有効にします。Request submission、Triage entry、Work Item、Planning target、
Documentはcanonical APIから作成し、operatorへ各sourceのread権限を付与します。実tenantのrow、実在人物、customer
本文、credentialを流用しません。各sourceにはfixtureの`forbiddenSubstrings`に入れる一意なsynthetic canaryを配置し、
model response、citation、uncertaintyのいずれにもraw canaryが戻らないことを検査します。
さらに6 journeyのWork Itemとは別のdrill専用Work Itemを作り、現在titleをexactな`titleA`または`titleB`のどちらかに
し、operatorへそのTeamのmember write権限を付与します。このdrillはrun開始時にcanonical GETで現在revision/titleを
読み、反対titleへ一度だけPATCHするため、revisionが
単調増加しても次のscheduled runは逆方向へ戻せます。Fixtureのrevisionやtitleをrunごとに手更新しません。

Fixtureは次のshapeを使います。`request`と`triage`、`work-item`と`document`を同じcaseへまとめず、必ず6件を
一つずつ指定します。Planning caseはWork Item caseと別にPlanning targetを解決します。Placeholderは実環境で作った
synthetic identifier/revisionへ置換し、JSON自体はrepository、artifact、issue、job logへ保存しません。

```json
{
  "schemaVersion": 1,
  "cases": [
    {
      "journey": "request",
      "request": {
        "task": "triage",
        "locale": "ja",
        "source": {
          "type": "request-submission",
          "formId": "<synthetic-form-id>",
          "submissionId": "<synthetic-submission-id>",
          "expectedRevision": 1
        }
      }
    },
    {
      "journey": "triage",
      "request": {
        "task": "triage",
        "locale": "ja",
        "source": {
          "type": "triage-entry",
          "teamId": "<synthetic-team-id>",
          "triageEntryId": "<synthetic-triage-id>",
          "expectedRevision": 1
        }
      }
    },
    {
      "journey": "work-item",
      "request": {
        "task": "summary",
        "locale": "ja",
        "sources": [{
          "type": "work-item",
          "teamId": "<synthetic-team-id>",
          "workItemId": "<synthetic-work-item-id>",
          "expectedRevision": 1
        }]
      }
    },
    {
      "journey": "planning",
      "request": {
        "task": "planning",
        "locale": "ja",
        "source": {
          "type": "planning-target",
          "target": {
            "type": "initiative",
            "entityId": "<synthetic-initiative-id>"
          },
          "expectedRevision": 1
        }
      }
    },
    {
      "journey": "document",
      "request": {
        "task": "summary",
        "locale": "ja",
        "sources": [{
          "type": "document",
          "documentId": "<synthetic-document-id>",
          "expectedRevision": 1
        }]
      }
    },
    {
      "journey": "search",
      "request": {
        "task": "search",
        "locale": "ja",
        "query": "<synthetic-search-intent>"
      }
    }
  ],
  "staleRevisionRequest": {
    "task": "triage",
    "locale": "ja",
    "source": {
      "type": "triage-entry",
      "teamId": "<synthetic-team-id>",
      "triageEntryId": "<synthetic-triage-id>",
      "expectedRevision": 1
    }
  },
  "postProviderSourceFence": {
    "teamId": "<synthetic-drill-team-id>",
    "workItemId": "<synthetic-drill-work-item-id>",
    "locale": "ja",
    "titleA": "Synthetic provider fence title A",
    "titleB": "Synthetic provider fence title B"
  },
  "withheld": [
    {
      "generationId": "<permission-changed-generation-id>",
      "reasonCode": "permission-changed"
    },
    {
      "generationId": "<source-changed-generation-id>",
      "reasonCode": "source-changed"
    },
    {
      "generationId": "<retention-expired-generation-id>",
      "reasonCode": "retention-expired"
    }
  ],
  "forbiddenSubstrings": ["<seeded-sensitive-canary>"],
  "expectedModelId": "jp.anthropic.claude-sonnet-4-6",
  "expectedPromptVersion": "ai-assistance-v1",
  "budgets": {
    "maxLatencyMsPerGeneration": 12000,
    "maxInputTokensPerGeneration": 2000,
    "maxOutputTokensPerGeneration": 1000,
    "maxCostUsdPerGeneration": 0.1,
    "maxTotalInputTokens": 14000,
    "maxTotalOutputTokens": 7000,
    "maxTotalCostUsd": 0.7
  },
  "durability": {
    "workspaceId": "<synthetic-workspace-id>",
    "memberId": "<synthetic-member-id>"
  }
}
```

`expectedModelId`と`expectedPromptVersion`はdeploy parameterと同じexact値を固定し、別model/profileまたは古いpromptを
同じrunの証拠として扱いません。`durability.workspaceId`はroleの`dynamodb:LeadingKeys`とexactに一致させ、
`memberId`は全journeyを実行するsynthetic operatorのcanonical member IDにします。Fixture object、各case wrapper、
`postProviderSourceFence`、withheld、budget、durabilityに未知fieldや欠落fieldがある場合もfail closedにします。
Drillのteam/Work Itemは6 journeyとstale requestの全Work Item sourceからdistinctで、titleは異なる2つのbounded exact値に
します。Aggregate budgetは6件の成功generationだけでなく、source fenceで意図的に破棄する7件目のpaid attemptも含めます。
7件目を開始する前に、6件の実測totalへper-generation上限を加えてもaggregate上限内に収まるheadroomを必須にし、
不足時はproviderを呼ばずstableな失敗証拠を返します。
`staleRevisionRequest`は現在値より古いpositive revisionを固定します。`withheld`には同じoperatorで事前作成した
generationをexact 3件指定し、source accessを外した`permission-changed`、source revisionを進めた`source-changed`、
effective retentionを期限切れにした`retention-expired`を各1件ずつ準備します。Reasonの欠落、重複、追加はfixture parse
時点でfail closedにします。DynamoDB TTL削除は非同期なので、retention caseはrowの物理削除ではなくlogical
`retention-expired`を合格条件にします。Fixture更新後はmanual jobを実行し、scheduled runを待って初回検証にしません。

### Live checks and response-loss drill

Evaluatorはunique paid keyを16秒間隔にして既定member rate limit内に保ち、次をfail closedで確認します。

- Request、Triage、Work Item、Planning、Document、Searchをdeployed API経由で実modelへ送る。
- 全generationをproduction parserで検証し、source-backed caseのcitation、全caseのuncertainty、task、exact model/prompt、provider、
  positive input/output token、cost、latencyとper-case/aggregate budgetを確認する。
- Responseを512 KiBまでstreamingで読み、超過時はcancelする。全responseにseeded canary、実access token、JWT、email、
  AWS access-key形、Authorization header、署名URL credentialがないことを確認する。
- Work Item generationの最初のresponse bodyを読まずにstream cancelし、同じ`Idempotency-Key`で再送する。再送は
  strict generationに加えserver-owned `Idempotency-Replayed: true`を必須にする。
- 他の5 journeyも最初のresponseにreplay headerがなく、同じkeyの2回目がexact同一generationかつ
  `Idempotency-Replayed: true`であることを必須にする。
- Approvalも最初のbodyを読まずに再送し、同じ`outcome`と古い`expectedRevision`が同じapproved generationへ
  replayすることを確認する。これはdomain resourceを自動更新しないreview decisionだけである。
- Feedbackも最初のbodyを読まず同じkey/bodyで再送し、最初はreplay headerなし、2回目は`204`、empty body、
  `Idempotency-Replayed: true`になることを確認する。同じprocessのexact-key readでdeterministic feedback identityのrowが
  一つだけになることも確認する。
- Stale source requestを同じkeyで2回送り、両方`409/AiAssistanceSourceChanged`、2回目に
  `Idempotency-Replayed: true`があることを確認する。Providerを再実行できるnew keyへ自動変更しない。
- 上記の安全なHTTP checkがすべて成功した場合だけ、drill専用Work Itemをcanonical GETしてcurrent revisionと`titleA`/`titleB`
  をstrictに確認し、7件目のsummary generationを開始する。同じreceiptをstrong `GetItem`でbounded pollし、全pre-provider
  recheck後にmodel runnerをinvokeしてからexact CASで永続化されるsingleton `attempt.providerStartedAt`を確認してから、同じ
  Work Itemを反対titleへrevision-fenced PATCHする。Admission用の`attempt.status=started`だけではprovider開始の証拠にしない。
  PATCHは`Idempotency-Key`/`X-Correlation-Id`を持ち、response-loss時だけ同じkeyで再送し、
  replay responseまたはcanonical GETのexact `revision + 1`/反対titleでcommitを照合する。
- 7件目は`409`とbounded exact code set `{AiAssistanceSourceChanged, AiAssistanceAuthorizationChanged}`のいずれかで失敗し、
  receipt outer/attemptのcategory/codeがHTTPと一致し、singleton failed attemptの`providerOutcome=succeeded`、positive usage/cost/
  latency、redacted audit、future TTL、generation row absenceを必須にする。Replay前後にreceiptとgeneration absenceをstrong readし、
  同じgeneration keyのreplayがexact同一errorと`Idempotency-Replayed: true`を返しreceiptを一切変えないことを確認する。
- 7件目のHTTP待ちを局所的にcancelしてもAPI Gateway/Lambdaや有料Provider呼び出しが停止したとはみなさない。開始後のpoll、
  mutation、response検証のいずれかが失敗した場合は、同じkey/bodyのsafe replayとstrong `GetItem`をboundedに継続し、terminal
  failed receiptとgeneration absence、またはcompleted receiptとcanonical generation linkageまで照合する。後から判明したpositive
  usage/costは失敗reportの7件目とaggregate totalsへ加算する。期限内にpendingがterminal化しない、rowがmalformed、usageを
  回収できない場合は`post-provider-source-fence-unreconciled`でpromotionを停止し、client abortを取消証拠として扱わない。
- Pre-arranged generation 3件をすべてGETし、`permission-changed`、`source-changed`、`retention-expired`それぞれの
  expected `withheld` reasonだけが返り、draft/citationが返らないことを個別に確認する。Aggregate checkだけでなく
  reasonごとのfixed booleanもreportへ残す。この3 GETがpermission/source/retentionのdisclosure/apply fail-closedを引き続き
  担当し、active drillはpost-provider source revision/commit fenceだけを担当する。
- HTTP transcript完了後、canonical helperから導出したkeyだけを`DynamoDBDocumentClient`のstrongly consistent
  `GetItem`で読む。6件のcompleted receipt、各receipt内のsingleton succeeded attempt、`providerOutcome=succeeded`、
  public usage、redacted request/context/citation audit、対応する6 generation rowを照合する。Work Item rowは元generationの
  content/detailsを維持してrevisionが一つ進み、approved decisionが保存されていることを必須にする。
- 各completed receiptとgeneration rowのtop-level DynamoDB TTLはpublic `generation.expiresAt`をepoch秒へ切り捨てた
  exact値と一致し、一つのevaluation時刻より未来でなければならない。Feedback rowも対象Work Item generationと同じ
  retention deadlineを継承し、stale failed receiptのTTLもevaluation時刻より未来であることを確認する。
- Stale receiptは`failed/AiAssistanceSourceChanged`でattemptなし、receiptが割り当てたcanonical generation keyにもrowなしを
  必須にする。Feedbackはsubmitted body/keyから導出したdeterministic identity、fingerprint、canonical rowをexactに照合する。
  `attempt.audit`とgeneration rowの`request`/`auditedInput`はproduction parser/redactorで再検証し、seeded canary、Bearer/JWT、
  AWS access key、authorization header、署名URL credential、email shapeがあれば失敗させる。
- Durability確認後にunauthenticated healthを再確認し、開始時と終了時の両方が
  workflowの同じfull commit SHAでなければ混在deployとして失敗させる。

CLIはschema v2のcontent-free reportだけをstdoutへraw fileとして書き、workflowはlogへ表示しません。後続`jq`が
schemaを完全に検証できた場合だけ別のvalidated fileを作り、そのvalidated fileだけを30日artifactとして保存します。
Validationまたはlive evaluationが失敗したrunではartifact uploadを実行せず、未検証raw fileを公開しません。
Reportに許可するのはfixed journey名、stable failure code、boolean check、token/cost/latency/citation countの集計と、
fixed durability boolean/countだけです。成功時のdurability値はreceipt `7`、successful attempt/audit/generation各`6`、
feedback `1`、stale attempt/generation absenceとapproved decisionがすべて`true`です。加えてpost-provider failed receipt、
failed attempt、audit envelopeが各`1`、post-provider generation absenceが`true`です。Totalsは6件の成功generationと
破棄した7件目のpaid attemptを一度ずつ加算し、same-key replayは加算しません。
API URL、account、Workspace/member/source/generation/idempotency/model/trace ID、commit SHA、email、token、request、
response、citation、生成本文、table名、raw AWS errorは含めません。Workflowはreportのtop-level、journey、checks、
durability、totalsのkey集合と上記exact値を`jq`で検証し、未知fieldも拒否します。Journeyとtotalの全numeric fieldは
JSON numberを必須にし、token、citation、latencyはintegerも必須にします。Checksはcommit/replay/stale、post-provider source fenceとwithheld aggregate、
`permission-changed`、`source-changed`、`retention-expired`の個別booleanがすべて`true`でなければなりません。

```sh
bun server/scripts/ai-assistance/evaluate-ai-assistance-live.ts \
  > ai-assistance-live-eval-report.raw.json
```

### Blocking metric evidence approval

Live jobが成功した後だけ、`needs: live-evaluation`の`metric-evidence-approval` jobを開始します。このjobは
`permissions: {}`でcheckout、OIDC、AWS credential、secretを持たず、CloudWatch read権限も追加しません。GitHub
Environment `ai-assistance-live-metric-evidence-approval`を事前に作成し、deployment branchを`main`だけに制限し、
deploy actorとは分離したrequired reviewerを設定します。未作成environmentは無保護でauto-createされ得るため、protected
environment variable `AI_ASSISTANCE_LIVE_METRIC_EVIDENCE_GATE=required-reviewers-enabled`も必須にします。Variableが欠落または
別値ならjobはfail closedになりますが、このsentinelはrequired reviewerとmain-only protectionの代用ではありません。
Environment設定のscreenshot/export、reviewer roster revision、branch protectionをrelease evidenceへ残します。

Required reviewerはlive reportの開始・終了に対応する同一runのUTC windowで、CloudWatch namespace
`Mukuroji/AIAssistance`、dimensionをexactに`Service=mukuroji-ai-assistance`だけへ固定し、次のgeneration、provider、
token/cost、decision metricが到着していることを確認してからjobを承認します。

- `GenerationRequestCount`、`GenerationSuccessCount`、`GenerationReplayCount`、`GenerationFailureCount`、
  `GenerationLatency`
- `ProviderAttemptCount`、`ProviderSuccessCount`、`ProviderFailureCount`、`ProviderThrottledCount`、
  `ProviderTimeoutCount`、`ProviderRefusedCount`、`ProviderInvalidOutputCount`、`ProviderLatency`
- `InputTokenCount`、`OutputTokenCount`、`EstimatedCostUsd`、`UsageUnavailableCount`
- `DecisionCount`、`DecisionApprovedCount`、`DecisionRejectedCount`

Failure-onlyの`ProjectionFailureCount`は正常runでdatapointが存在しないため到着必須metricには含めませんが、
同じlive UTC windowに正のdatapointがないことを確認します。正のdatapointがあればpartial-batch retryが発生しており、
live reportが成功していてもpromotionを停止して調査します。

Evidence recordにはworkflow run URL/ID、対象full SHA、live UTC開始/終了、確認したfixed metric名と最終datapoint UTC、
reviewerとapproval時刻を残します。Generation/Workspace/member/source ID、本文、model/trace、credential、raw CloudWatch
responseは残しません。別run、別SHA、別windowのmetricや以前の承認を流用せず、このblocking jobが未承認ならworkflow
全体を成功扱いにしません。

Generation completionのEMF/logは本文やidentifierを含めず、boundedな`failureCategory`/`failureCode`だけを持つため、
失敗理由を安全にqueryできます。Provider throttle/timeout/model refusal/invalid outputはそれぞれ専用metricで集計し、
model refusalはboundedな`refusalReason=content-filter`、人間によるrejectは`DecisionRejectedCount`で追跡します。
Providerやmodelが返す自由文を失敗理由として記録しません。

Generation request metricはrequest境界で同期記録し、provider attemptとdecision metricはterminal
receipt/generationの`WorkspaceSearchTable` NEW_IMAGE streamから専用Lambdaが投影します。Terminal mutationは
transaction/CASで一度だけcommitされますが、DynamoDB Streamsはat-least-once配送なので、成功応答喪失、
partial-batch retry、承認済みmanual replayでmetricが稀に重複し得ます。処理できないrecordはretry後に
14日保持・Retainの`AiAssistanceObservabilityDlq`へ隔離します。このSQS Bodyはraw recordではなく
`DDBStreamBatchInfo`だけなので、queueやenvelopeをworkerへ直接redriveしません。24時間以内にexact
stream/shard/sequence範囲を復元し、filter件数とendpointを照合してから限定invokeする手順と、期限超過時の
metric gap処理は[Operational readiness](./operational-readiness.md#ai-assistance-observability-failure-destination)に従います。
Partial batch response自体はLambda `Errors`を増やさないため、workerはpartial-batch failureとして返したrecord数を
`ProjectionFailureCount`として集約し、専用alarmで検出します。DynamoDB Streamsが実際に再試行する範囲はlowest failed
sequence以降を含み得るため、このmetricをretry総record数とは解釈しません。Content-free failure logとEMFは90日保持・
Retainの明示LogGroupへ保存し、raw stream imageやidentifierは書きません。

Release rehearsalは上記の別provision read-only OIDC roleを使い、同じfull evaluator process内でsynthetic partitionの
receipt/generation/attempt audit/feedbackを自動検証します。このreadはcanonical primary keyごとの`GetItem`だけであり、
table-wide inventoryやpolicy mutationの証拠を集めません。今回のrunはAI policyを変更しないため、別のAudit tableや
`ai-assistance.policy.updated` eventを読みません。OIDC role、exact table ARN、synthetic `LeadingKeys`条件が未設定ならjobを
fail closedとし、HTTP replayだけのrunを完全なdurability evidenceとして合格させません。

### AI-specific rollback

`GenerationFailureCount`、`ProjectionFailureCount`、`ProviderFailureCount`、`ProviderTimeoutCount`、`ProviderRefusedCount`、
`ProviderInvalidOutputCount`の増加、
latency/cost budget超過、citation/redaction/withheld/replay failure、commit不一致のいずれかでpromotionを停止します。

1. 新しいAI generationを停止する。影響Workspaceをpolicyでdisableし、横断的な機密性incidentでは既存global runtime
   controlをdisableにする。現在はdeployment-wide AI専用kill switchがないため、全Workspaceを安全に止められない場合は
   global API停止またはreview済みforward deployを選び、その制約をincident recordへ残す。
2. Lambda timeout以上待ってin-flight provider callを終了させ、content-free report、metric、alarm、deploy parameter、
   artifact digestを固定する。Prompt/source/output/credentialをincident ticketへ複製しない。
3. 直前の成功codeをrevertした新しいmain commitとして作り、前回のexact model ID/profile ARN、destination ARN、region、
   input/output price、budget、retention設定を使って、新しい`ApiRuntimeConfigurationRevision`とそのfull
   `ApplicationCommitSha`でforward deployする。古いconfiguration revisionを別内容へ再利用しない。
4. Retained Workspace Search/Audit table、generation、receipt、attempt、counter、feedback、policy auditを削除・巻き戻し
   しない。新schemaを旧codeが安全に読めない場合は旧binaryへ戻さずforward-fixする。
5. Health/ready、offline gate、同じnew commit SHAのmanual live evaluation、上記CloudWatch metricとsynthetic
   receipt/audit確認を再実行してからAI policy/global runtime controlを再enableする。

Model変更はscheduled/manual eval、IAM/parameter diff、cost/latency review、rollback parameter inventoryが揃うまで
production allowlistへ追加しません。

AWS一次情報:

- [Claude Sonnet 4.6 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4-6.html)
- [Inference profile IAM prerequisites](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html)
- [Supported inference-profile Regions and models](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html)
- [AWS SDK for JavaScript credential chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)
