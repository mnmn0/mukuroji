# Unified Triage queue

Issue #191 の Triage queue は、Form、chat、email、webhook、manual handoff を通常の
Backlog へ直接作成する前に、同じ受入判断へ通す Team 単位の管理面である。個人向け
Inbox は通知と deep link を所有し、Triage queue は受入状態、担当、SLA、routing、
source trace の source of truth を所有する。

## Entry contract

`TriageEntry` は source provider の raw payload ではなく、現在の権限と retention で
表示可能な allowlist 済み projection を保持する。すべての source は次を共通に返す。

- source kind と provider 側の安定 ID
- permission-filtered title/body preview、requester、受信時刻、最終 activity 時刻
- reply の可否と unavailable reason
- routing reason、候補 Team/Project、現在の owner
- SLA target、breach/escalation 状態、snooze 期限
- permission、guest visibility、retention expiry
- canonical Work Item pointer と append-only activity
- current principal に対して server が計算した action capability

Chat/Webhook の raw body、credential、署名、temporary URL、provider token は Entry に
保存しない。外部 actor を内部 Workspace member として扱わず、source provenance を
維持する。Permission loss または retention expiry では Entry 自体を黙って削除せず、
本文、requester、attachment metadata、permalink を redaction し、監査と再配送の照合に
必要な最小 source identity だけを残す。

## State machine

状態は次の6種類に限定する。

```text
pending ───────────────> accepted
   │ ├─────────────────> duplicate
   │ ├─────────────────> declined
   │ ├─────────────────> snoozed ── due/new activity ──> pending
   │ └─────────────────> needs-information ── reply ───> pending
   │
needs-information ─────> accepted | duplicate | declined | snoozed
snoozed ───────────────> accepted | duplicate | declined | needs-information
```

`accepted`、`duplicate`、`declined` は terminal である。同じ idempotency key と同じ
fingerprint の response-loss retry だけ既存結果を返す。Terminal 後に source activity が
届いた場合は canonical Work Item/source thread へ追記するが、Entry を再 open しない。
Owner の変更は state を変更しない。

既存 Entry と設定を変更する mutation は `expectedRevision` を要求し、stale write を conflict にする。
新規 manual handoff は source identity claim と idempotency receipt で競合を防ぐ。Idempotency key は
Workspace、Team、Entry または source、operation、normalized input fingerprint に束縛し、同じ key の
異なる入力を拒否する。Actor の current authorization は別途毎回検証し、client fingerprint 自体を
actor の自己申告へ依存させない。

## Routing, ownership, SLA, and escalation

Team configuration は ordered routing rules、owner pool、rotation、source ごとの SLA、
escalation steps、許可する bulk action を versioned state として保存する。Rule は
permission-filtered source kind/metadata だけを評価し、本文を command として実行しない。
最初に一致した rule が routing reason と候補 Team/Project を提示するが、Accept 時には
current Team/Project/workflow permission と configuration を再検証する。

Owner rotation の保存と Form/manual admission の各評価試行は active Workspace member を検証する。
保存後に member が退会・権限変更された場合は admission を fail closed にし、configuration の更新
または rotation maintenance を要求する。Unowned Entry は明示的に表示し、空の owner pool を
暗黙の system owner で隠さない。

設定更新は configuration row と90日TTLの fingerprint-bound receipt を同じ transaction で保存する。
応答消失後の同一入力は live member/Project reference を再評価する前に committed snapshot を返し、
異なる入力で同じ key を再利用した場合は conflict にする。Queue response は設定全体を開示せず、
現在許可された bulk action 名だけを permission-safe policy として返す。

Sparse wake index は `snoozedUntil`、SLA target、次 escalation 時刻の最小値を保持する。
Schedule worker は shard ごとに due row を bounded query し、revision と wake timestamp を
CAS で再検証する。Snooze の期限到来は `pending` へ戻し、新しい source activity は期限前でも
同じ再浮上を行う。SLA breach/escalation は冪等な activity と通知 outbox を作り、同じ schedule
occurrence の retry で二重通知しない。

## Accept and Duplicate

Accept は一つの flow で次を選択する。

1. Candidate route を使って新しい canonical Work Item を作成する。
2. 現在参照可能な既存 Work Item へ source を link する。

新規作成は Work Item、Triage `accepted` state、source association、append-only activity、
audit/outbox、operation receipt を同じ DynamoDB transaction で確定する。応答消失後は stable
source ID から既存 Work Item と receipt を返し、二重 Work Item を作らない。既存 link でも
Work Item owner/revision、Team/Project permission、source permission を commit 時に再検証する。

Duplicate は canonical Work Item を指定し、新しい Work Item を作らない。Canonical Work Item の
revision condition、Triage terminalization、source association、deterministic
`triage-context-merged` event、Entry の merge receipt を同じ transaction で確定する。Snapshot は
Triage Entry ID、source kind、merge 時点の visibility/retention、allowlist 済み lifecycle summary、
comment/attachment/watcher のメタデータ件数だけを保持する。Canonical Work Item から Triage deep
link を辿ることで、current source permission と retention の範囲内にある元 context を参照できる。

Source body、requester、provider/raw source ID、permalink、attachment 名、watcher/actor identity、
temporary URL、private object key は canonical Work Item へコピーしない。実データを watcher へ
subscribe したり、message/File を別 storage へ物理移送したり、duplicate Work Item 全体を redirect
する処理はこの snapshot contract の保証に含めない。権限消失後も receipt の件数と安全な provenance
だけが残り、restricted/redacted availability として表示する。

## Source adapters

Production で初期 Entry を作成する compose 済み ingress は Form と manual handoff である。
Chat、new-email、Webhook は共通 contract/state machine/source-claim を利用する adapter 境界を持つが、
provider の tenant/signature/reply 検証を行う production adapter が接続されるまでは初期 ingestion と
request-information を fail closed にする。未配送の reply や未作成 Entry を成功として返さない。

### Form

Request submission と Triage Entry は session consumption、receipt、duplicate pointer と同じ
transaction で作る。作成直前に current Team configuration を strong read し、Form rule、Project、
fixed/rotation owner、SLA、retention を適用する。Rotation cursor は Entry と同じ transaction の
conditional write で進め、rotation がない場合も configuration revision（未保存 default なら row
non-existence）を同じ transaction で検証する。競合時は configuration を再読し、active Project、
owner、escalation owner を再検証して割当を再評価する。Requester Web/email reply は Request thread
へ保存すると同時に Triage activity を進め、`snoozed` /
`needs-information` を一度だけ `pending` へ戻す。従来の Request queue は form administration の
互換面とし、Team の受入判断は Triage を使う。

### Chat

Provider adapter が署名、installation tenant、scope、replay window を検証した normalized event
だけを渡す。Source identity claim は provider/workspace/conversation/thread を一意にし、再配送で
Entry を重複作成しない。Accept/duplicate 後は external-chat の link/binding と permission/
retention policy を再利用する。

### Email

既存 Request email handler は既存 thread reply 専用である。新規 email intake は別の signed
envelope と handler を使い、sender、recipient、Message-ID、spam verdict、rate limit を provider
境界で検証する。HTML、quoted history、任意 header を routing command として扱わない。

### Webhook

将来の production adapter は `automation` と `triage` を混同しない明示 purpose と routing 設定を
持ち、署名検証済み normalized envelope だけを Triage に渡す必要がある。現行 Automation inbound
endpoint は Triage ingress として接続せず、すべての webhook を暗黙に request とみなさない。
Adapter 接続時も同じ provider event ID/同じ fingerprint は replay、異なる fingerprint は conflict
にする。

### Manual handoff

Authenticated Team member が source reference と permission-filtered preview を渡す。
Client が Workspace、role、owner、SLA を自己申告しても認可根拠にせず、server が current
principal と Team configuration から補う。Persistence client も commit ごとに configuration を
strong read して同じ evaluator を適用し、rotation cursor の conditional write を Entry、source
claim、operation receipt と同じ transaction に含める。Rotation がない場合も revision/non-existence
guard を含め、競合時は current configuration と live reference を再評価する。Project-scoped caller
では prepared Project と再評価後 Project の差分を conflict にし、認可済み scope を越えて保存しない。

## Authorization and tenancy

- Queue read は `teams.read` と Entry の assigned Project に対する viewer access を要求する。
- Action は `teams.write`、non-guest、対象 Entry/移動先 Project の member access を要求する。
- Accept/link/duplicate は canonical Work Item の current write permission も要求する。
- Rule、owner rotation、SLA、escalation の変更は Team manager または Workspace admin に限定する。
- Reply は Entry capability だけでなく source adapter の current reply permission を再検証する。
- Workspace guest は Team Triage API 自体を利用できない。将来 source thread に限定した guest
  boundary を追加する場合も、`guestVisible` な allowlist 以外の routing reason、private comment、
  relation、requester contact は返さない。
- Partition key、source claim、cursor、receipt は Workspace に束縛し、別 tenant の ID を入力しても
  existence を開示しない。

## API and UI

Team-scoped internal API は次を提供する。

```text
GET       /api/teams/{teamId}/triage-entries
GET       /api/teams/{teamId}/triage-entries/{entryId}
POST      /api/teams/{teamId}/triage-entries/{entryId}/actions
POST      /api/teams/{teamId}/triage-entries/bulk-actions
POST      /api/teams/{teamId}/triage-entries/manual-handoffs
GET|PUT   /api/teams/{teamId}/triage-settings
GET       /api/teams/{teamId}/work-items/{workItemId}/triage-sources
```

UI は `/teams/{teamId}/triage?entryId=...` を canonical route とする。Desktop は scan 可能な
queue と permission-aware detail pane、mobile は list/detail の drill-in を使う。Queue row は
source、requester、received/last activity、state、owner/unowned、SLA、candidate route を表示する。
Bulk toolbar は選択時だけ表示する。

Keyboard は Arrow/Home/End で row を移動し、Enter で detail を開く。Accept、Duplicate、Decline、
More information、Snooze shortcut は確認 form を開くだけで、terminal action を直接実行しない。
Input、textarea、select、contenteditable、IME composition 中は shortcut を処理しない。操作後は
focus を queue row へ戻し、success/conflict は `aria-live` で通知する。

Personal Inbox は Triage state を複製しない。Assignment、SLA、escalation notification から Team
Triage Entry へ deep link し、Triage から canonical Work Item と source thread へ、Work Item から
source association を介して Triage Entry へ戻れるようにする。

## Staged GSI rollout

`RequestIntakeTable` は既存の retained table である。DynamoDB の `UpdateTable` は1回に1つの GSI
しか作成できず、CloudFormation は追加した GSI の backfill 完了を待たずに stack update を進める。
そのため、既存環境へ3つの Triage index を同時追加してはならない。

CDK context `triageIndexDeploymentStage` は次の累積 stage だけを受け付ける。

1. `team`（programmatic default）: `triage-team-activity-index` だけを追加する。Schedule worker はまだ作らない。
2. `owner`: Team index を維持し、`triage-owner-activity-index` だけを追加する。
3. `wake`: 前2つを維持し、`triage-wake-index` と Triage schedule worker を有効にする。

Production CDK entrypoint は context 省略を fail closed にする。完了済み環境へ誤って `team` template を
再適用し、owner/wake index を削除しないよう、synth/deploy のたびに現在の stage を明示する。

```sh
bun --filter cdk cdk deploy -c triageIndexDeploymentStage=team
# triage-team-activity-index が ACTIVE になったことを確認する
bun --filter cdk cdk deploy -c triageIndexDeploymentStage=owner
# triage-owner-activity-index が ACTIVE になったことを確認する
bun --filter cdk cdk deploy -c triageIndexDeploymentStage=wake
```

既存環境では各 deploy の後に `DescribeTable` で table と追加 index の `IndexStatus=ACTIVE`
を確認してから次へ進む。`team` から `wake` へ飛ばさず、backfill 中に別の table/index update を
行わない。失敗した stack update を rollback する前には実 table の index 状態を確認し、template
との差分を解消する。Rollout 完了前は owner query が Team index fallback を使い、schedule は Scan
へ降格せず disabled response を返す。

新規環境は `CreateTable` で複数 GSI を同時作成できるため、初回 deploy から明示的に `wake` を選べる。
CI の完全形 synth も `wake` を使う。Programmatic `CdkStack` の省略値は単体 test 用に `team` だが、
production entrypoint は context 未指定の synth/deploy を許可しない。

Local DynamoDB の Request Intake bootstrap は既存環境の CloudFormation update ではなく新規
`CreateTable` なので、Request queue index と3つの Triage index を一度に作成する。すでに存在する
local table は4 index の key schema を検証し、不完全な schema を黙って利用しない。Production の
一段階ずつの rollout gate と `RequestIntakeTable` の logical ID はこの local bootstrap に影響されない。

## Verification and operations

自動 test は少なくとも次を固定する。

- source event replay と同一 ID/異 payload conflict
- 全 state transition、terminal immutability、revision conflict
- Snooze 期限と新 activity の再浮上
- Accept の response-loss retry と create/link permission recheck
- Duplicate の source association、permission-safe snapshot、metadata count、lifecycle summary 保持
- Cross-tenant、guest、permission loss、retention redaction
- SLA/escalation schedule retry と lease/CAS loss
- Bulk partial conflict と個別 retry
- Inbox ↔ Triage ↔ Work Item ↔ source の deep link
- Keyboard-only flow、screen reader semantics、390px mobile layout

運用では oldest pending age、unowned count、SLA breach count、schedule lag、action conflict、
source permission loss、retry/DLQ depth を監視する。Schedule Lambda は async retry と暗号化済み
DLQ を持ち、DLQ または destination delivery failure を alarm にする。Backfill/import は
source claim と state machine を迂回せず、dry-run、bounded page、checkpoint、再実行安全性を持つ。
