# 0042. Analytics の履歴を Work Item ごとの圧縮済み history row で持ち、audit の entity timeline は不足分だけ読む

- 状態: 提案
- 日付: 2026-11-21
- 関連: Issue #371、PR #581、PR #660、[ADR 0008](0008-audit-stream-two-readers-and-worker-secrets.md)、
  [ADR 0013](0013-data-migration-runner.md)、[ADR 0031](0031-data-migration-lambda-and-operator-proof.md)、
  [docs/analytics.md](../analytics.md)

## 背景

Analytics の query は、現在参照できる canonical Work Item を Team partition から読み、`asOf` へ巻き戻すために
Work Item ごとに `AuditEventsTable` の `EntityOccurredAtIndex` を query する（[docs/analytics.md](../analytics.md)）。
1 query で読む entity timeline は 500 件、Audit page query は合計 500 回、返却 event は合計 10,000 件までで、
超えると `413`（`AnalyticsHistoryLimitExceeded`）で fail-closed にする。

PR #581 で期間開始より前から更新のない Work Item の history を読まないようにし、PR #660 で Web の既定 filter を
直近 30 日と閲覧者の Team にした。それでも、期間中に更新された Work Item が 501 件以上ある report（四半期・年度、
複数 Team の横断、定期配信）は今も `413` になる。

上限が 500 なのは、history を読む Work Item 1 件ごとに最低 1 回の Query が要り、entity timeline には
comment・file・context item など Analytics が使わない event も載るためである。上限を上げても、読み取り回数と
応答時間が Work Item 数に比例して伸び、別の上限で同じ問題が戻る。

制約は次のとおり。

- なるべく安く動かす。常時課金の resource（新しい table の provisioned capacity、Kinesis、OpenSearch など）を足さない。
- 結果の意味を変えない。filter・group-by・`asOf` の巻き戻し・evidence・現在の ACL での再評価は今と同じ値を返す。
  metric contract の version を上げない。
- 不整合のまま部分集計を返さない（今の read barrier と fail-closed を保つ）。
- `AuditEventsTable` の stream reader を増やさない（ADR 0008）。
- 最初の AWS deploy は 2026-11-22 以降で、この変更の実装はその後になる。既存の Work Item には backfill が要る。

## 決定

選択肢 A を採る（2026-11-21 に Shinji が承認）。

- `AnalyticsTable` に Work Item ごとの history row を足す。
  - key: partition `workspaceId`、sort `WORK_ITEM_HISTORY#<encodeURIComponent(teamId)>#<encodeURIComponent(workItemId)>`。
  - 属性: `entryType: 'analytics-work-item-history'`、`schemaVersion: 1`、`teamId`、`workItemId`、
    `coveredRevision`（どの canonical revision までの event を反映したか）、`entries`。
  - `entries` は target が Work Item 自身の audit event だけを古い順に持つ。1 entry は `eventId`、`occurredAt`、
    `action`、`afterRevision` と、engine の `normalizeAnalyticsFieldPath` が扱う field（title、status category、
    Project、担当者、type、期限、custom field、archive、見積・残工数、作成・更新日時）の変更だけを持つ。
    `redacted` の印は残す。comment・file・context item の event と、それ以外の field は持たない。
- 書き込みは `CollaborationProjectionFunction` の audit projection の fan-out に足す（新しい stream reader は作らない）。
  - Work Item の event を受けたら、`eventId` がまだなく、event の `afterRevision` が `coveredRevision + 1` のときだけ
    entry を足して `coveredRevision` を進める（conditional update）。同じ event の再送は何もしない。
  - 順序が飛んだとき（`afterRevision` が `coveredRevision + 1` より大きい）や row がないときは、その Work Item の
    entity timeline を audit から読み直して row を作り直す。backfill と同じ関数を使う。
  - Work Item の削除 event では row を消す。
  - row が 350 KiB を超えるときは `overflow: true` にして `entries` を捨てる。reader はその Work Item だけ audit から読む。
- 読み取り（API の `readAuthorizedAnalyticsData` と定期配信の runner の両方）は次のようにする。
  1. history が要る Work Item（`selectAnalyticsWorkItemsRequiringHistory` の結果）の history row を BatchGetItem
     （100 key ずつ、結果整合性の読み取り）で読む。
  2. `coveredRevision` が canonical の `revision` と一致し、`overflow` でない row は `entries` を engine 用の
     `AuditEventV1` の形に戻して使う。`eventId` は元の audit event のものなので、evidence は今と同じ event を指す。
  3. row がない、`coveredRevision` が古い（projection の遅れ）、`overflow` の Work Item だけ、今の entity timeline の
     query で読む。この audit 経路の上限（500 件など）は今のまま残す。
  4. 今の read barrier（前後 2 回の canonical read の fingerprint 一致と、latest revision の event の到達確認）は
     そのまま使う。history row から来た event も同じ確認を通す。
- history を読む Work Item の上限は、history row で読める分について、今の「参照可能な Work Item 合計 10,000 件」に揃える。
  history row から読む entry は 1 query 合計 200,000 件まで（API Lambda の memory に収まる量）とし、超えたら `413`。
  audit 経路で読む Work Item が 500 件を超えたときも今と同じ `413` を返す。
- 権限の判定は変えない。history row は、現在の ACL を通った canonical Work Item の分だけ読み、巻き戻した Project が
  現在読めない event は今と同じく engine が除外する。
- 保持期間と legal hold は audit event に合わせる。entry は元の audit event の `expiresAt` を持ち、tenant の保持期間の
  反映や legal hold で audit event が更新されると（stream の MODIFY）、projection が同じ entry の `expiresAt` を
  書き換える。projection は書き込みのたびに `expiresAt` を過ぎた entry を落とし、reader も使わない。row には最も早い
  entry の `expiresAt` を `historyExpiresAt` として持たせ、`AnalyticsTable` の TTL にする（この table の TTL を持つ
  row は history row だけ）。audit の保持期間を過ぎた値が row に残り続けないようにするためで、消えた row は次の
  event で audit から作り直される。Tenant の閉鎖では `AnalyticsTable` の Workspace partition と一緒に消える。
- Projection の更新が失敗したら（throttle など）、その Work Item の row を消して batch は失敗にしない。保持期限の
  変更は revision を進めないため、古い期限のまま row を残すと最新に見えてしまう。row を消せば reader は audit から読み、
  次の event で作り直される。同じ fan-out の通知などを再試行・DLQ に巻き込むのは、row を消すことも失敗したときだけにする。
- entity index は結果整合性なので、作り直しの直前に書かれた event が読めないことがある。`coveredRevision` を revision 1
  以外から数え始める（古い event が保持期間で消えている）のは、最も古い entry が 1 時間より前のときだけにする。revision は
  時刻とともに増えるため、それより前の revision はさらに古く、index の遅れではなく保持期間で消えたと判断できる。
  そうでなければ `coveredRevision` を 0 にして audit から読ませる。
- 既存の Work Item は data migration runner（ADR 0013・0031）で backfill する（下の「移行と backfill」）。

Issue #371 の「やること」は Team・Project ごとの日次集計（選択肢 B）を挙げているが、完了条件のうち
「事前集計の値が既存 engine の値と一致する」と「権限のない Work Item が集計値に含まれない」を filter・group-by・
`asOf` を含めて満たせないため、engine に渡す入力（履歴）の側を事前に圧縮する A を推奨する。完了条件との対応は次のとおり。

- 3,000 件の Work Item を持つ Project・複数 Project をまたぐ report: history row で読むので 500 件の上限にかからない。
  表示・snapshot・export・定期配信は同じ reader を通る。
- 既存 engine と同じ値: engine は変えず、同じ fixture を audit 経路と history row 経路の両方で集計して、snapshot の
  metric 値と evidence が一致することを test で確かめる（projection の重複・順序の飛び・`overflow` の場合も含める）。
- 権限: 読む Work Item は今と同じ現在の ACL で選ぶ。
- 追加の固定費: なし（下の費用）。

## 検討した選択肢

費用は ap-northeast-1 の on-demand 料金（読み取り約 $0.14 / 100 万 RRU、書き込み約 $0.71 / 100 万 WRU、
保存約 $0.29 / GB 月、2026-11 時点の概算）で、50 人、Work Item 1 万件、Work Item の更新 月 10 万回、
Analytics の query（画面・evidence・定期配信の合計）月 3,000 回、1 query で history が要る Work Item 2,000 件として見積もった。

- 選択肢 A（推奨）: Work Item ごとの圧縮済み history row（上の「決定」）。
  - 費用: history row の平均を 2 KB とすると、書き込みは更新 1 回 2 WRU で月約 $0.14、読み取りは 1 query
    2,000 row × 0.5 RRU で月約 $0.43、保存と PITR は 20 MB で $0.01 未満。合計 月 $1 未満で、固定費は増えない
    （table・GSI・Lambda・stream reader を足さない）。
  - 利点: 結果の意味が今と同じで、engine と metric contract を変えない。filter・group-by・evidence・`asOf`・現在の
    ACL での再評価がすべてそのまま動く。history の読み取りが Work Item 1 件 1 Query から 100 件 1 BatchGet になり、
    Analytics が使わない event を読まない。projection が遅れても、その Work Item だけ audit から読むので結果は正しい。
  - 欠点: 同じ事実（Work Item の変更）を audit と history row の 2 か所に持ち、projection の fan-out が 1 つ増える。
    保持期間を audit と揃える処理が要る。Workspace の history row は 1 つの partition に載るため、1 query で
    数千 row を読むと partition の読み取り上限（3,000 RCU/秒）に近づく。今の規模では問題にならないが、
    1 query で 1 万 row 近く読む Workspace が出たら partition を Team ごとに分ける。
- 選択肢 B: Team・Project ごとの日次集計（analytics-schedule が毎日、metric の値を集計 row に書く）。
  - 費用: 毎晩の集計で全 Team の Work Item と当日の audit を読み、月 $0.5〜1 程度。読み取りは最も少ない。
  - 欠点: 集計済みの値からは、担当者・type・status・custom field・`workItems` の filter、group-by、cycle time や
    lead time の分布、evidence の明細、任意の `asOf`（日中の時刻）を再現できない。report の timezone ごとに日の境界も
    変わる。現在の ACL での再評価（Team 内の Project 単位の権限、Project の移動）もできず、閲覧者ごとに
    結果が変わる今の規則を守れない。filter のない Team・Project 単位の report だけが速くなり、それ以外は今の経路と
    `413` に残る。metric の定義を 2 つの経路で保つ必要もある。
- 選択肢 C: key を変えずに上限だけ上げる（entity timeline の query の並列数を増やし、500 件を 2,000 件にする）。
  - 費用: 1 query で entity timeline を 2,000 回 query し、Analytics が使わない event も読むため 1 回 1〜4 RRU、
    月約 $1〜2。実装は最も小さい。
  - 欠点: 返却 event の上限（10,000 件）と Lambda の時間・memory も一緒に上げる必要があり、応答時間が Work Item 数に
    比例して伸びる。2,000 件を超えると同じ `413` が戻る。A を入れるまでのつなぎとしては使える。
- 選択肢 D: Team ごとの transition row（変更 1 回 1 row、sort key を Team と時刻にして Team 単位で Query）。
  - 費用: 書き込みは 1 回 1 WRU で A より安いが、読み取りは history が要らない Work Item の分も含めて Team の全履歴を
    読む。1 万件 × 10 回の変更で約 15 MB、1 query 約 1,900 RRU、月約 $0.8。
  - 欠点: 期間開始より前から更新のない Work Item を読まない最適化（PR #581）が効かず、Team の履歴が伸びるほど
    読み取りが増える。

## 移行と backfill

1. 1 回目の deploy: projection の fan-out（history row の書き込み）と reader（history row を優先し、足りない Work Item
   だけ audit）を同時に入れる。backfill 前は history row がないので、すべて今の audit 経路で読み、挙動は今と同じ。
   deploy の後に変更された Work Item は、projection が row を作る（row がなければ audit から作り直す）。
2. backfill: data migration runner に migration `analytics-work-item-history` を足す。
   - 対象は `WorkItemsTable` の canonical Work Item row。scan segment ごとに読み、Work Item ごとに entity timeline を
     audit から読んで history row を作り、`AnalyticsTable` に put する。条件は「row がない、または
     `coveredRevision` が作った row より小さい」。projection と競合しても新しい方が残る。
   - PR #671 の `kind: 'derive'` は source row だけから派生 row を作る純粋関数なので、audit を読む lookup の port を
     runner に足す（同じ migration の `classify` / `transform` に audit reader を渡す）。canonical row は書き換えない。
   - `data:migrate:aws run --migration <id>` の dry run で件数と `overflow` の数を確かめてから `--apply`、最後に
     `verify`（すべての canonical Work Item に `coveredRevision` が canonical の revision と一致する row、または
     `overflow` の row がある）を通す。
   - 費用: Work Item 1 万件で、scan 約 2,000 RRU、audit の query 約 1 万〜2 万 RRU、書き込み約 2 万 WRU。1 回 $0.05 未満。
   - runner の拡張は PR #671 の上に積むため、この ADR を入れる PR とは別の PR にする。この PR が最初の deploy より前に
     入る環境では、すべての Work Item が作成時から row を持つので backfill は要らない。
3. backfill の途中でも結果は正しい。row がない Work Item は audit から読むため、backfill が進むほど `413` が出にくくなるだけ。
4. 戻すとき: reader を今の audit 経路に戻す deploy だけでよい。history row は残しても読まれない。消すときは
   `WORK_ITEM_HISTORY#` の prefix を消す。

## 結果

- 期間中に更新された Work Item が 501 件以上でも、history row がそろっていれば `413` にならない。上限は今の
  「参照可能な Work Item 10,000 件」になる。
- Analytics の応答時間が短くなり、Analytics が使わない event を読まなくなる。費用は月 $1 未満で、固定費は増えない。
- 受け入れる欠点: Work Item の変更を audit と history row の 2 か所に持つ。projection の遅れや順序の飛びは、その
  Work Item だけ audit から読むことで吸収する。
- 見直す条件: 1 query で読む history row が 1 万に近づいたら Team ごとの partition に分ける。filter のない
  Team 単位のダッシュボードで応答時間が問題になったら、選択肢 B を A の上の cache として検討する。
- 更新した文書: `docs/analytics.md`（history の読み方と上限）、`docs/architecture.md`（projection の fan-out）、
  `docs/guide/pm.md`（集計できる件数）。`docs/data-migration.md`（migration の一覧）は backfill の PR で更新する。
