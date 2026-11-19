# 0011. Planning の revision を Work Item の更新と Planning の変更で数え分ける

- 状態: 提案
- 日付: 2026-11-20
- 関連: Issue #370、[docs/planning.md](../planning.md)「永続化と並行更新」

## 背景

Planning の変更は Workspace に 1 つある `FENCE#<workspaceId>` / `META` の `revision` に対する CAS で守っている。
Canonical Work Item の作成・更新・削除も、roll-up の入力を 1 つの条件で守るために同じ `revision` を進める。
そのため、多人数や coding agent が Work Item を更新している間は、PM の Planning 操作が
`409 PlanningRevisionConflict` になり続けた。

制約は次のとおり。

- 同じ entity への同時編集、cascade preview / confirm の revision 束縛、archive や rollover が `META` の
  revision を Work Item ごとの条件の代わりにしている前提は崩さない。
- 新しい table、GSI、Work Item の書き込みごとの追加の read を増やさない。
- `META` を書く writer は複数ある（Planning、Work Item、file proofing、workspace access、directory）。
  対応を忘れた writer があっても、安全側（409）に倒れる。

## 決定

- Work Item の transaction は `META` の `revision` と一緒に `sourceRevisionCount` を `ADD` で 1 つ進める。
  Work Item 用の IAM（`grantPlanningRevisionFenceAccess`）が更新できる属性に `sourceRevisionCount` を足す。
- Planning の commit は `META` を書くとき、自分の revision を `structureRevision`、そのときの
  `sourceRevisionCount` を `structureSourceRevisionCount` に書く。commit は `revision` の CAS なので、
  読んだ後に Work Item の書き込みが入っていれば commit 自体が失敗する。
- `revision - structureRevision == sourceRevisionCount - structureSourceRevisionCount` なら、最後の Planning
  commit 以降は Work Item だけが revision を進めている。counter を書かない writer が revision を進めると
  差が合わなくなり、Planning の変更として扱われる。counter がない `META` も同じく変更ありとみなす。
- Work Item の状態に依存しない操作（entity の作成・更新・複製・移動、entity 間 dependency、Work Item link の
  作成・置換、Cycle への一括追加・削除）だけが、呼び出し元の `expectedRevision` が `structureRevision` 以降で、
  そこから Work Item だけが進めた場合を受け付ける。これらの Work Item 側の操作は、認可に使った Work Item の
  revision を同じ transaction で検査し、認可後に Work Item が別 Project へ移った場合などは失敗させる。
  Work Item link の削除は Work Item の revision を検査しないため、完全一致のままにする。route は現在の snapshot で認可し、client は commit 直前に再検査し、Work Item の
  書き込みに追い越された commit は最大 3 回まで読み直して再試行する。
- Archive・restore・rollover・次の Cycle・Work Item dependency・update の publish / cadence は、従来どおり
  revision の完全一致を要求する。

## 検討した選択肢

- 選択肢 A（採用）: 同じ `META` row に counter を足して、Work Item による前進を数え分ける。
  利点: row・key・GSI を増やさず、Work Item の書き込みは条件なしの `ADD` のままなので Work Item 同士は
  競合しない。対応していない writer は自動的に安全側になる。
  欠点: どの操作が rebase してよいかを Planning 側で操作ごとに決める必要がある。
- 選択肢 B: Planning の構造用と roll-up 入力用に別の revision row を持つ。利点: 意味が分かれて明快。
  欠点: Work Item 用の IAM、authorization snapshot、archive・rollover の条件、Web の `expectedRevision`
  まで二本立てになり、変更範囲が大きい。
- 選択肢 C: Team / Project 単位に revision を分割する。利点: 無関係な Team の変更とも競合しない。
  欠点: graph 全体の検証（階層・cycle chain・capacity）が Workspace 単位なので、分割した revision だけでは
  守れない。Planning graph の分割（別 Issue）と合わせて検討する。

## 結果

- 別の利用者や agent が Work Item を更新している間も、Milestone の日付変更や Cycle への link が成功する。
- 既存の `META` は counter を持たないので、最初の Planning commit までは従来どおり 409 になる。
- Workspace member や Team / Project の変更で `META` を Put し直すと counter が消え、次の Planning commit
  までは従来どおりの完全一致になる。
- Work Item の状態に依存する操作の 409 は残る。必要になったら、その操作ごとに Work Item の revision 条件を
  足して rebase 対象に加える。
- 更新した文書: `docs/planning.md`、`docs/guide/pm.md`。
