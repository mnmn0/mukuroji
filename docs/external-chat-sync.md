# External chat thread sync

## 目的と境界

Slack と Microsoft Teams の会話を provider 固有 payload のまま扱わず、外部 thread を
canonical Work Item の source として取り込み、reply、編集、削除、完了、再開を双方向に同期する。
provider-neutral contract は `contracts/src/external-chat.ts` が所有し、provider adapter はその境界で
署名検証、権限確認、pagination、順序情報、Markdown 変換を行う。

既存の `ExternalWorkItemLink` と Public API OpenAPI schema は source-control の互換境界である。
chat thread は独立した `ExternalChatWorkItemLink` を使い、既存 enum や closed response object を
拡張しない。将来 Public API に公開する場合も、新しい path と schema を追加し、既存の
`integrations:*` と `work-items:*` scope、`Idempotency-Key`、revision 条件を適用する。

内部の canonical Work Item、collaboration comment、scan 済み File が業務状態の保存元である。
外部 actor は Workspace member と同一視せず、外部 message と内部 comment の対応は
`ExternalChatMessageBinding` に明示する。provider の raw webhook、access token、refresh token、
一時 download URL、provider cursor はこの contract と public response に流さない。

### この変更が提供する範囲

この変更は provider-neutral contract、DynamoDB 永続化境界、link 単位の inbound/outbound retry
executor、provider 共通 fixture を提供する。Slack/Teams の実 adapter、production ingress/command、
application composition は登録しない。また、全 link を横断する due queue discovery、具体的な DLQ、
Lambda、schedule、IAM、alarm も有効化しない。そのため、この変更単独では production の webhook 受付、
自動 retry、運用 alert が稼働すると主張しない。

provider integration の follow-up では、adapter と cross-domain port を composition root へ接続し、
shard された bounded due projection から対象 link を発見する dispatcher、idempotent な DLQ、retry
handler、least-privilege IAM、queue age/DLQ alarm を一体で追加する。dispatcher は eventual な候補だけを
発見し、最終的な順序と実行可否は、この変更で提供する strong link-local FIFO executor が再検証する。

## 正規化モデル

- `ExternalChatWorkspace` は Slack workspace または Teams tenant を表す。
- `ExternalChatConversation` は channel、group、direct chat、meeting を表す。
- `ExternalChatThreadReference` は workspace、conversation、thread、root message の canonical ID を
  一意に指す。permalink、選択された reply、quoted range は policy により消去できる metadata とする。
- `ExternalChatThreadSelection` は create/link command 専用で、認可済み HTTPS permalink を必須にする。
  command 検証後に保存する locator は `ExternalChatThreadReference` へ狭め、retention redaction 後も
  provider read/mutation は canonical ID だけで再開できるようにする。
- `ExternalChatQuotedRange` の offset は正規化後 Markdown に対する UTF-16 の半開区間とする。
  adapter は provider の block/entity 表現から本文を正規化した後に offset を確定する。
- `ExternalChatMessage` は actor、permalink、時刻、quoted range、attachment、編集・削除状態を持つ。
  本文や actor を開示できない場合は optional field を省略し、空文字や架空の actor で補完しない。
- `ExternalChatThreadSnapshot` は認可済み message の bounded page である。`hasMoreMessages` と
  application 発行の署名付き `nextMessageCursor` で続きを取得し、provider cursor は返さない。
- `ExternalChatSyncCursor` は同期 runtime だけが読む durable checkpoint であり、provider cursor と
  最後に commit した event を保持する。表示 pagination cursor と兼用しない。

`schemaVersion` は provider-neutral record の移行境界である。provider ID は installation の
provider と一致しなければならず、現在は `slack` と `microsoft-teams` だけを許可する。

adapter が型付き object を返しても、その object 自体は trust boundary の外側にある。runtime は
workspace、conversation、thread、message、actor、quote、attachment、webhook、mutation result を
deep allowlist で再構築し、canonical timestamp、bounded text/array、credential を含まない HTTPS URL、
resource state ごとの disclosure rule を検証する。余剰 field、provider SDK object、`importedFileId`、
一時 URL はこの再構築で破棄し、削除・retention tombstone に本文を残した応答は失敗として扱う。
各 adapter は provider が所有する permalink host を宣言し、runtime は URL credential、port、fragment、
localhost/IP literal、token・signature・authorization に加えて Slack `pub_secret`、AWS `X-Amz-*`、
Google `X-Goog-*` などの一時 credential query を正規化した key で拒否する。redirect や短縮 URL を
許可する場合も、adapter が最終 URL を解決してから同じ host policy を通す。

## 作成、link、unlink、同期設定

外部 thread から Work Item を作る操作は、現在の provider access と Work Item configuration を
検証し、Work Item、`ExternalChatWorkItemLink`、source claim、初期 message binding、audit/outbox、
idempotency receipt を同じ論理 transaction で確定する。応答消失後の同一 request は既存の
Work Item と link を返し、二重作成しない。receipt は最初に確定した response snapshot と時刻を保持し、
同じ key でも request fingerprint が異なる場合は既存結果を返さず conflict にする。

既存 Work Item への link も team と Work Item の閲覧・更新権限、installation 所有範囲、source
access を現在値で検証する。同じ provider/workspace/conversation/thread を active link が一意に
claim し、別 Work Item へ無言で再割当てしない。同期方向の更新、unlink、resync は link revision を
条件にする。unlink は外部 source や既に import 済みの内部 comment/File を削除せず、以後の同期を
停止して audit に残す。

`resume` resync は保存 checkpoint から再開し、`full` resync は現在の権限で bounded source を
再取得する。どちらも stable operation ID を持つ非同期処理として retry され、受付時点を同期成功と
表示しない。

resync worker は operation ID、mode、受付時 link revision を所有する private cursor を CAS で claim
し、受付時の authorization generation も固定する。provider page は deep normalization と source scope
検証後、message occurrence 順で処理し、page 内の全 message が terminal outcome になった場合だけ provider
continuation と観測時刻を checkpoint する。古い generation の job/cursor は再認証後に再利用しない。`full`
は traversal 中に durable seen manifest を構築し、最後まで到達した後で未観測 binding を tombstone/reconcile
してからだけ成功にする。job の terminal cursor を先に commit してから、private lifecycle、exact parent
fence、authorization generation を条件に link 表示を投影するため、投影直前の crash も replay で修復できる。
以前完了した `resume` 受付は古い cursor を即成功にせず page 1 から fresh traversal を開始し、新着を確認する。

## 双方向 message と thread state

外部 reply の create/edit/delete は、それぞれ internal comment の作成、版更新、削除 tombstone へ
写像する。内部 comment の create/edit/delete も同期方向が許す場合だけ外部 provider へ送る。
message binding は external message ID、external version、internal comment ID、internal version、
origin、最後の inbound event と outbound operation を保持する。

comment、File import、resource redaction、Work Item lifecycle、message binding の各 port は、link ID と
副作用前に観測した link revision/Team/Work Item owner に加え、workspace/conversation の exact
present-or-absent parent fence snapshot を同じ commit で条件確認する。message binding の DynamoDB
transaction も link row と両 parent fence row を ConditionCheck するため、duplicate merge、親 lifecycle、同期が競合した場合は
旧 Work Item に確定せず retry される。binding commit は link row の private storage revision も同じ
transaction で進めるため、merge が binding を事前走査した後の commit は merge の最終 CAS を失敗させる。
副作用が merge より先に commit した場合は link provenance により merge transaction/manifest の移動対象となる。

outbound adapter は provider request の準備後、不可逆な provider I/O の直前に service が渡す exact
authority guard を await する。guard は link owner/revision、parent fence snapshot、effective lifecycle、
retry cancellation signal を再検証する。provider transport は同じ `AbortSignal` を実 request へ伝播し、
guard rejection または permit lease loss 後に新しい provider/persistence side effect を開始しない。

外部 actor の ID と表示名は external identity snapshot として保存し、`authorMemberKey` を偽造しない。
内部側の表示では source kind と provider permalink を併記する。内部 member が外部へ送った reply は
送信した Workspace actor と connector application の双方を audit で追跡できるようにする。

thread completion/reopen は Work Item の現在の workflow と遷移可能性を再検証する。固定 status 名を
仮定せず、設定上の許可された完了・再開遷移だけを適用する。対応する遷移がない、revision が競合する、
または同期方向が許さない場合は source state だけを更新し、`conflict` または `paused` として表示する。
内部 Work Item の完了・再開を外部へ送る場合も同じ規則で、provider がその lifecycle を表現できない
場合は成功扱いにしない。

thread lifecycle は link revision を所有する fenced lease として `processing` から `completed` へ進め、
内部/外部 side effect と次 state/outcome を先に固定する。外側の inbound/outbound receipt が commit した
後だけ `acknowledged` に解放する。crash replay は completed outcome を再利用して link projection を修復し、
unacknowledged lease がある間は settings update、unlink、resync、duplicate merge を競合として止める。

## 権限、redaction、attachment

source の resolve、snapshot read、link、webhook replay、outbound mutation、resync のたびに次を
現在値で確認する。

- caller が対象 Team/Work Item を閲覧または更新できること。
- installation が対象 workspace/tenant に属し、必要 scope と consent を現在も持つこと。
- connector principal が conversation、thread、message、attachment を現在も取得できること。
- provider event の workspace/tenant が installation と一致し、署名と replay window が有効なこと。

一度取得できたことを将来の権限として cache しない。権限や retention により開示できなくなった本文、
actor、attachment metadata は projection から省略する。email、raw profile、raw webhook、token、
Authorization header、temporary URL を Work Item、comment、audit metadata に保存しない。

source view は provider read の前後で link owner/revision、現在の Work Item 閲覧権限、installation の
authorization generation、exact parent fence snapshot と effective lifecycle を照合する。外部 read 中に
unlink、merge、親 restriction、権限剥奪、再認証が発生した場合は
取得済み内容を返さず、現在の canonical route と認可で明示的に再試行する。

表示 pagination cursor は application が AES-256-GCM で暗号化・認証する opaque token とし、Workspace、
principal、link、provider、link revision、authorization generation、期限へ束縛する。active key と期限内の
retained key だけで復号し、scope 不一致、改ざん、期限切れ、廃止 key は同じ一般化した invalid cursor として
拒否する。provider cursor の平文、署名だけの token、再認証前の cursor を client へ返さない。

外部 attachment は `ExternalChatAttachment` では metadata と stable permalink だけを表す。adapter DTO
に `importedFileId` が含まれていても内部 File identity として信用せず除去する。本文を取り込む場合は
現在の installation authorization と provider metadata を private Files upload pipeline へ渡し、malware
scan と既存の File authorization を通過した後に pipeline が返した canonical File ID だけを binding へ
保存する。provider download URL を永続化しない。duplicate merge では binding と scan 済み File の
所有関係も canonical Work Item へ移す。

## 切断、scope 変更、削除、retention

`sourceAvailability` は「いま接続できるか」、`sourceState` は「最後に確認した lifecycle」を表し、
両者を混同しない。

同期を止める判定と metadata を消去する判定も分離する。temporary unavailable、needs-reauth、installation
disconnect は新しい read/import/mutation を止めるが、直ちに保持済み display metadata を消去する理由には
しない。`retained-metadata` は許可された metadata を保持したまま content 同期と retry payload を止める。
permission loss、scope change、deleted、retention-expired のときだけ policy-controlled metadata と
imported projection の redaction cascade を行う。

lifecycle event は workspace、conversation、thread、message、attachment の scope ごとに異なる
discriminated contract とし、親 scope の event に架空の conversation/thread ID を補わない。link の
private lifecycle projection は workspace/conversation/thread ごとの観測値を保持し、authorization
revision、発生時刻、event ID の順で stale event を拒否する。表示状態は各 scope のうち最も制限の強い
availability/state を採用するため、古い child event や通常の content 同期成功が親の restriction を
解除しない。message/attachment の redaction port も同じ発生時刻と event ID を durable に比較し、古い
更新を `stale` として扱う。

- installation disconnect または reauthorization 必要時は同期を pause し、復旧後に明示的な resync を
  行う。古い credential で成功したように見せない。
- scope 変更や conversation permission loss は `scope-changed` / `permission-lost` として保存し、
  認可されない本文や attachment を返さない。
- provider source の削除は tombstone として反映し、既存 Work Item を自動 hard-delete しない。
- provider または Workspace policy が metadata/permalink の保持を許す期間だけ
  `retained-metadata` を使う。期限後は `retention-expired` とし、表示名、本文 snapshot、permalink、
  attachment metadata を policy に従って消去する。

permission loss、scope change、source deletion、retention expiration では、link の workspace/conversation
表示名と permalink、source permalink、quoted text を消去し、復旧に必要な provider/workspace/
conversation/thread/root/source-message ID だけを残す。message/attachment lifecycle は同期方向が
`outbound` または `none` でも必ず idempotent collaboration redaction port へ渡す。再認証済みの provider
operation が成功すれば availability/status は回復させるが、消去済み metadata は fresh source read または
明示 resync が現在権限で再取得するまで復元しない。

workspace/conversation lifecycle は installation を含む完全な parent scope を、Workspace partition 内の
link record prefix から strongly consistent な bounded base-table page で列挙する。eventual-consistent GSI の
空ページを terminal success にしない。親 receipt に page cursor を checkpoint し、各 link は派生 child receipt
で projection、deferred purge、collaboration/File redaction cascade を exactly-once に進める。inactive row や
別 installation の同名 ID は fan-out に含めない。restrictive link には non-lifecycle content を新規 defer
できない DynamoDB condition を置き、redaction と retry payload 保存の競合でも内容を復活させない。

親 lifecycle event は fan-out の列挙前に workspace または conversation 単位の durable fence として
authorization generation、availability/state、event/operation ID、発生時刻、同期 block 判定を確定する。
この block 判定は metadata redaction 判定とは別である。create/link transaction は
source resolve 時の authorization generation と workspace/conversation 両方の fence を condition-check する。
したがって restrictive fence と link 作成が競合しても、link が strong scan に見えるか、古い generation の
link commit が拒否されるかのどちらかになり、scan 直後の取りこぼしを作らない。再認証後の新しい generation
だけが古い restrictive fence を越えられる。link の private record は source resolve 時 generation を保持し、
fan-out page は自身の fence generation より新しい link を除外する。各 child の link projection transaction も
同じ parent fence の generation、availability/state、event/operation ID、発生時刻、block 判定を
condition-check するため、
後続 parent event が先に勝った古い child は `stale` となり redaction cascade を開始しない。復旧した metadata は
明示 resync の fresh read で再構築する。

切断、削除、permission loss を `not found` に丸めず、利用者が再認証可能か、source が消えたかを
区別して表示する。ただし、その理由自体が source の存在を漏らす principal には一般化した forbidden
または not-found response を返す。

## 冪等性、順序、loop、rate limit

provider webhook は at-least-once として扱う。adapter が検証した stable `eventId` と正規化 payload、
runtime-only origin marker の fingerprint を receipt に保存し、同じ ID/同じ認証済み入力は既存 outcome
を返す。同じ ID/異なる入力は conflict として隔離する。deferred row は origin marker を永続化しないため、
その fingerprint は正規化 event だけから計算し、receipt fingerprint と混用しない。最後の event ID
一個だけで重複排除せず、保持期間内の receipt と message/thread ごとの version binding を使う。
各 adapter は `normalizeWebhook` の先頭で共通 validator を呼び、provider 固有 parser より前に webhook
request の raw body、header 数、case-normalized header 名、値、header 合計 byte 数を検証する。deep
normalization 後の各 inbound event は JSON UTF-8 で 180 KiB 以下に制限する。deferred identity/FIFO の
両 row に同じ event を保持しても、各 DynamoDB item の key と envelope に 400 KiB 上限まで十分な余白を
残す。

順序判定は provider adapter が `externalSequence` と external version を解釈する。古い編集や削除は
`stale` として skip し、前提となる message が未着なら `out-of-order` として defer して bounded fetch
または再配送で補う。timestamp の大小だけで last-write-wins にしない。

outbound operation は retry 間で stable な `operationId` を使う。provider が client idempotency key を
受け付ける場合は同じ値を渡し、受け付けない場合は送信 receipt、直後の reconciliation、message binding
で重複を検出する。応答消失時に exactly-once を保証できない provider では、その制約を監視と UI に
明示する。

reply、edit、delete、thread completion/reopen のすべてで adapter は同じ `operationId` の provider-side
結果を reconcile する。provider commit 後に response が失われても再送で版をもう一度進めず、同じ
normalized result を返す。adapter contract は四 mutation について response-loss replay を共通 fixture で
検証する。

自分の outbound mutation が webhook として戻った場合は、adapter が認証済み metadata から復元した
`originOperationId` と保存 receipt を照合して `self-origin` として副作用を止める。本文中の marker や
利用者が編集できる文字列だけで loop を判定しない。marker は対象 action と message ID/version または
thread lifecycle state/version、保存済み outbound operation のすべてが一致した場合だけ有効とする。
認証済み marker であっても別 action/resource/version へ再利用できない。内部 correlation chain に同一の
link/message operation が現れた場合も停止する。

429 または provider quota は `rate-limited` として defer し、検証済み Retry-After と local jitter を
使う。link 単位の FIFO 性を保ちつつ installation 全体の concurrency を制限し、期限超過は DLQ と
運用 alert に送る。一部失敗を thread 全体の同期成功として commit しない。

Retry-After は canonical future timestamp かつ local scheduling horizon 内だけを採用する。欠落、過去、
不正形式、過大な未来値は local fallback へ置換し、operation ID 由来の deterministic jitter を加える。
同一 receipt replay の時刻は安定しつつ、同時 retry の集中を避ける。

deferred retry worker は link ごとに due event を occurrence 順の bounded batch で処理する。先頭が再度
defer、retryable failure、または別 processor の有効な lease に到達した時点で停止し、後続を追い越さない。
applied、skipped、non-retryable failure の terminal outcome だけを provider / installation / event ID の
完全な identity で削除する。Webhook の runtime-only origin marker は deferred row に保存も再構成もしない。
queue row の削除は terminal receipt と replay-safe audit の commit 後にだけ行う。したがって副作用後の
crash でも row が receipt lease の再取得を駆動し、先に row だけを失うことはない。

inbound/outbound の deferred record は identity row と occurrence-ordered FIFO row を同じ transaction で
保存し、worker は FIFO row を strongly consistent な bounded Query で読む。先頭の `retryAt` が未来なら
後続が due でも停止する。outbound worker は attempt ごとに固有 owner と単調増加 fence token を持つ
installation permit を取得し、provider 呼出し直前に renew/validate した後も、provider promise が settle
するまで lease の 1/3 間隔で heartbeat を続ける。adapter の provider-I/O guard と completion の各
persistence side effect は、その時点の exact permit owner/fence/expiry を durable store で再検証する。
heartbeat scheduler、renew、validate の失敗を含めて permit を確認できない worker は transport へ渡した
`AbortSignal` を中断し、processor の停止を待ってから permit を解放する。deferred outbound row は
enqueue 時の Team、Work Item、link revision と exact parent fence snapshot を保持し、unlink、merge、
restrictive lifecycle と競合した stale queue write を transactionally 拒否する。restrictive purge は同じ
link revision と parent fence snapshot を条件に inbound content と outbound queue の両方を消去するが、
再開に必要な lifecycle control event は残す。期限超過時は注入された idempotent dead-letter port への記録を
先に確定し、receipt を `dead-lettered` へ終端化して identity/FIFO row を同じ transaction で除去する。
crash replay は終端 receipt を返し、provider を再呼び出さない。

## Duplicate merge と canonical redirect

duplicate Work Item の統合は canonical/duplicate Work Item revision と全 link revision を fence した
一つの論理 transaction とする。caller は duplicate owner の active link を完全な集合として渡し、store は
strong scan の結果に加えて owner manifest の generation と件数を照合する。link の追加・unlink は同じ
transaction で manifest を進めるため、準備後に link が増減した merge は conflict になる。DynamoDB の
100 action 上限に収まらない場合は `too-large` として一切変更せず拒否し、別の段階的 merge 設計なしに
部分移動しない。上限内では次を不可分に移す。

- external chat link と一意な source claim
- message binding と inbound/outbound idempotency receipt
- import 済み File と attachment の Work Item 所有関係
- sync cursor、保留中 outbox、retry/DLQ 参照
- actor/source/correlation/outcome を保持した audit relationship

旧 Work Item/source route には `ExternalChatCanonicalRedirect` を残す。source permalink や過去の
notification から旧 ID を開いても canonical Work Item へ解決し、旧 Work Item に新しい reply を
作らない。merge 開始後の webhook は revision/merge lock を検出し、旧 owner へ適用せず defer して
canonical link へ再解決する。同一 thread の link が canonical 側にもある場合は binding、File、cursor
を決定的に統合し、一意制約の競合を無視しない。

redirect lineage は旧 Team/Work Item と moved link の組ごとに全件を同じ merge transaction で保存する。
navigation はその決定的な先頭 route を使い、merge 前に queue 済みの outbound event は自身の link ID、
provider、thread identity に一致する lineage だけで canonical owner へ rebase する。

merge command の応答消失を receipt から replay する場合も、旧 duplicate route の access check は保存済み
権限を信用せず canonical redirect を解決し、現在の canonical Work Item 権限を満たす principal にだけ
最初に確定した response を返す。

merge 後に旧 Work Item scope を持つ queued outbound event が到着した場合、旧 route の redirect が同じ
link/provider/thread と現在の canonical Team/Work Item を完全に指す時だけ rebase する。その後も現在の
principal authorization と link revision fence を再評価し、redirect が一致しない event は fail closed にする。

## Audit と観測性

create/link/update/unlink/resync/merge、inbound/outbound message、edit/delete、complete/reopen、
permission/retention lifecycle の各結果に audit event を残す。最低限、次を相関できるようにする。

- 操作を開始した Workspace actor、外部 actor snapshot、connector service identity
- team、Work Item、link、provider、workspace/conversation/thread/message の secret-free ID
- request/event/operation/correlation ID、同期方向、attempt、outcome と安定 error/reason code
- source occurrence time、受信 time、適用 time、retry/defer time、canonical redirect

本文、quoted text、token、raw provider payload、一時 URL、request fingerprint の原文は audit metadata
に保存しない。本文が必要な activity view は対象 Work Item の現在の閲覧権限で別途 projection する。
metric は provider/installation、event type、outcome、latency、rate-limit、lag、DLQ を集計し、tenant や
message 内容を high-cardinality label にしない。

command の成功 audit は業務 mutation と receipt と同じ transaction/outbox で確定し、`applied` を先書き
しない。transaction 前後の失敗は secret-free な安定 error code の security audit として別経路へ残す。
webhook 由来 correlation ID は provider の原文を監査へコピーせず、内部 namespace の一方向 digest へ
変換する。

## Provider adapter contract と検証

Slack/Teams adapter は共通 runtime へ provider SDK object を渡さず、次の能力を provider-neutral DTO
として実装する。

- installation と workspace/tenant の照合、webhook 署名・timestamp・replay 検証
- provider 所有 permalink host の宣言と、credential を含まない canonical URL の生成
- permalink からの thread reference resolve と現在権限の検証
- bounded thread/message page の取得と application cursor 用 continuation の封入
- actor、Markdown、quote、attachment、timestamp、version、lifecycle の正規化
- webhook の discriminated `ExternalChatInboundEvent` への変換
- reply create/edit/delete と thread complete/reopen の outbound mutation
- provider ordering token、idempotency capability、Retry-After、permission/retention error の分類

contract test は同じ fixture suite を Slack と Teams の両 adapter に適用する。root/reply、編集、削除、
完了/再開、quoted range、複数 attachment、pagination、重複 delivery、順序逆転、self echo、429、5xx、
disconnect、consent/scope change、permission loss、source deletion、retention expiration、malformed payload、
別 tenant payload を含める。E2E は外部→内部、内部→外部、応答消失 retry、duplicate merge 中の webhook、
canonical redirect、attachment import と権限剥奪後の redaction を検証する。

adapter fixture と log は実 token、個人 email、private message body を含めず、固定の synthetic data を
使う。provider API の sandbox が使えない test でも、同一 normalized event と outcome を再現できることを
adapter contract の合格条件とする。
