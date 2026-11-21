# 0037. Keyword 検索はタイトルだけを持つ sparse GSI を先に読み、本文だけの一致は従来の scan で探す

- 状態: 提案
- 日付: 2026-11-21
- 関連: Issue #372、PR #580、[docs/guide/member.md](../guide/member.md)「検索」

## 背景

Workspace 検索は `WorkspaceSearchTable` の `DOCUMENT#<entityType>#<entityId>` 行を key 順に読み、
1 request で最大 1,000 行（`WORKSPACE_SEARCH_EVALUATION_LIMIT`）を評価する。行ごとに現在の権限範囲を
source of truth から引き直してから keyword の部分一致（NFKC・小文字化）を見るため、評価する行数を
単純に増やすと読み取りと権限確認の費用が行数に比例して増える。PR #580 で Work Item・Project の prefix を
先に読むようにしたが、Work Item だけで 1,000 行を超える Workspace では、key 順で後ろにある Work Item の
タイトル一致が次の page に押し出される。

制約は次のとおり。

- なるべく安く動かす。常時課金の検索 service（OpenSearch など）は本当に必要になるまで入れない。
- 権限のない entity を結果に出さない既存の規則（行ごとの scope 再解決と RBAC）を変えない。
- 日本語を含む部分一致の意味を変えない（単語分割できない文字列でも一致する）。
- この変更の時点で AWS 環境は 1 つもなく、最初の deploy は stack 全体の新規作成になる。

## 決定

- `WorkspaceSearchTable` に sparse GSI `SearchTitleIndex` を足す。partition は `workspaceId`、sort は
  `searchTitleKey`、projection は `INCLUDE`（`entityId`、`title`、`subtitle`）。
- `searchTitleKey` は search document の行だけが持ち、値はその行の `recordKey`。書き込み時に
  persistence の境界（`toStoredWorkspaceSearchItem`）で足し、canonical document と projection digest には
  含めない。saved view・task view・AI assistance など同じ table のほかの行は index に載らない。
- keyword がある検索は 2 段階で読む。
  1. タイトル段階: entity type の順（Work Item → Project → …）に `SearchTitleIndex` を読み、
     `entityId`・`title`・`subtitle` だけで全語が一致した行だけ base table の行を読んで、従来どおり
     scope 再解決・RBAC・全 filter を通す。1 request で読む index 行は最大 20,000、権限確認する行は
     従来と同じ合計 1,000 まで。
  2. 本文段階: 従来の full row scan。タイトル段階が受け持った行（`searchTitleKey` を持ち、タイトルだけで
     一致する行）は飛ばすので、同じ結果が 2 回出ない。`searchTitleKey` のない古い行はここで従来どおり見つかる。
- どちらの段階の行かは base table の行で決める。index が少し遅れていても、ある行を両方の段階が返すことはない。
- cursor（暗号化済み）に `phase: 'title'` を持たせ、タイトル段階の途中から再開する。タイトル段階を
  読み切った後の cursor は本文段階の先頭（entity type の prefix）を指す。
- keyword のない検索（filter だけ）は従来の scan のまま変えない。
- 本文の keyword 判定は従来どおり scope 再解決の後に行う。Document は current source の本文が保存済みの
  本文（20,000 文字まで）より長いことがあるため。
- local の DynamoDB（Floci）では `ensureLocalWorkspaceSearchTable` が作成時に GSI を作り、GSI のない既存の
  local table には `UpdateTable` で足して ACTIVE まで待つ。

## 検討した選択肢

費用は ap-northeast-1 の on-demand 料金（読み取り約 $0.14 / 100 万 RRU、書き込み約 $0.71 / 100 万 WRU、
2026-11 時点の概算）で、Work Item 1 万件、行の平均 1.5 KB、title index 行の平均 200 B、keyword 検索
月 1 万回（50 人 × 1 日 10 回）、search document の書き込み月 10 万回として見積もった。

- 選択肢 A（採用）: タイトルだけの sparse GSI を先に読む。
  1 万件の title index 全体は約 2 MB で、1 回の検索が全件読んでも約 250 RRU。月 1 万回で約 $0.4、
  GSI の書き込みは月 10 万回で約 $0.07、保存はほぼ $0。
  利点: タイトル一致が Workspace のどこにあっても最初の page に出て、page をまたいでもタイトル一致が
  本文だけの一致より先に並ぶ。権限確認はタイトルが一致した行だけに行う。
  欠点: 本文だけの一致は従来どおり 1 page 1,000 行ずつ探すので、後ろにある本文一致は次の page になる。
  index が base table よりわずかに遅れる間、タイトルを変えた直後の行が一時的に見つからないことがある。
- 選択肢 B: 評価する行数の上限を上げて full row を読む。
  1 万件で約 15 MB、約 1,900 RRU / 回で、月 1 万回で約 $2.7。行ごとの権限確認も増える。
  欠点: 費用と応答時間が Workspace の大きさに比例し、上限を超えたところで同じ問題が戻る。
- 選択肢 C: DynamoDB 上の n-gram（2 文字単位など）の転置 index。
  利点: 読み取りが一致件数に比例して最も少ない。
  欠点: タイトル 1 件ごとに数十行、本文まで含めると数千行の index 行を書き、更新時の差分管理が要る。
  1 文字の検索語を扱えない。今の規模では A で足り、複雑さに見合わない。
- 選択肢 D: OpenSearch Serverless（または DynamoDB zero-ETL 連携）。
  利点: 本文を含む全文検索と関連度順がそろう。
  欠点: 最小構成でも OCU の常時課金で月 $170 以上かかり、既定構成全体（月 $10〜20）を大きく超える。

## 結果

- comment や Document、Work Item が数万件ある Workspace でも、Work Item のタイトル検索が最初の page で返る。
- タイトル一致を page をまたいで本文だけの一致より上に並べる（page 内の並べ替えは PR #580 のまま）。
- 本文だけの一致の取りこぼし（1 page 1,000 行）は残る。本文一致の需要が大きくなったら、選択肢 C を
  本文に限って足すか、選択肢 D を改めて検討する。
- 既存の AWS 環境ができた後にこの種の GSI を足すときは、CloudFormation の 1 回の更新で GSI を 1 本しか
  作れないことと、既存行への `searchTitleKey` の付与（#365 の migration）を考える。この ADR の時点では
  既存環境がないため backfill は用意しない。`searchTitleKey` のない行も本文段階で見つかる。
- 更新した文書: `docs/guide/member.md`（検索の並び順）。
