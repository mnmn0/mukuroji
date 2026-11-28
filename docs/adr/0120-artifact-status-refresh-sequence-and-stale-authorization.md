# 0120. pull request の照会は refresh の連番で接続を順に試し、古い credential の 401 で再認証にしない

- 状態: 提案
- 日付: 2026-11-28
- 関連: ADR 0103（一部を置き換え）、PR #820 の CodeRabbit 指摘

## 背景

ADR 0103 では、Workspace の GitHub 接続が 1 回の照会で試す 10 個より多いとき、試し始める接続を照会ごとに
無作為に選ぶとした。無作為なら再照会の周期と接続数がそろっても同じ 10 個に戻り続けることはないが、
同じ位置が続けて選ばれることはあり、読める接続にいつ届くかの上限がない。

ほかに次の 3 点が残っていた。

- check run が 500 件、review が 1,000 件を超えて読み切れない pull request は `unavailable` を返すが、
  前に確かめた状態があると一時的な障害と同じ扱いで前の状態を出し続け、確かめられていないことが伝わらない。
- report を 2,000 件読んで打ち切ったとき、表示中の report に pull request がないと Web は状態 API を呼ばず、
  古い report の pull request を確かめていないことを伝えない。
- connector の操作が 401 で失敗すると、失敗の後に読み直した最新の lifecycle revision で `needs-reauth` に
  している。操作中に再接続されると、古い credential の 401 が新しい接続を再認証に戻す。

## 決定

- 照会の claim の row（`agent-run-artifact-refresh#…`）に `refreshCount` を持たせ、claim のたびに 1 ずつ
  増やす（DynamoDB の `ADD`）。claim は増やした後の値（初回は 1）を返す。値のない既存の row は次の claim で 1 から数える。
  整合性検査は、`refreshCount` がないか 1 以上の整数であることを確かめる。
- 照会はこの連番で位置を決める。stale な pull request は連番ごとに 1 つずつ先頭をずらし、接続は owner と同じ名前の
  ものを先に置いたうえで、残りを `(連番 - 1) × 1 回に試せる数` の位置から試す。照会のたびに前回の続きを試すので、
  接続が n 個あれば ⌈n / 1 回に試せる数⌉ 回の照会で全部に届く。接続を一巡するたびに試し始める位置を 1 つずらすので、どの接続もいずれ最初に試され、応答の遅い接続が後ろの接続を時間切れにし続けることはない。無作為の開始位置は連番のない呼び出しにだけ残す。
- check run と review の履歴が長すぎて読み切れないときは `ConnectorProviderHistoryTooLong` で失敗させ、照会結果に
  一時的な障害ではないこと（`lasting`）を付ける。このときは前に確かめた状態を残さず、`unavailable` の未確認にする。
- Web は report の一覧に続き（`hasMore`）があるときも状態 API を呼び、`incomplete: true` なら、表示中の report に
  pull request がなくても会話の上に「古い報告の pull request を確かめていない可能性がある」旨を出す。
- connector の操作が認可の失敗（401 など）で終わったとき、その操作が使った credential が今も installation に
  保存されているときだけ `needs-reauth` にする。lifecycle の snapshot を読んでから credential を読み直して比べるので、
  比べた後に再接続されても revision の照合で更新が断られる。credential の更新（refresh）でも revision は進むため、
  開始時の revision ではなく、使った credential で古い失敗かを判断する。

## 検討した選択肢

- **開始位置を無作為のまま残す。** 状態が要らない。ただし届くまでの回数に上限がない。
- **接続ごとの試した位置を状態の row に保存する。** pull request ごとに続きを持てる。ただし状態の row は
  contract の形をそのまま保存しており、内部の位置を足すと読み取りと検査の両方が変わる。claim の row は Work Item に
  1 つで、すでに照会のたびに書いている。
- **開始時の lifecycle revision を `needs-reauth` の条件にする。** 指摘の案。credential の refresh や degraded の記録でも
  revision が進むため、操作中に自分で refresh した後の本物の 401 を見落とす。

## 結果

- 接続が多い Workspace でも、読める接続がある pull request は決まった回数の照会で確かめられる。
- 読み切れない pull request は古い check の結果を出し続けず、未確認と表示される。
- 操作中に再接続しても、古い 401 で新しい接続が再認証を求められることはない。古い 401 を見送った場合も、
  今の credential が本当に失効していれば次の操作で `needs-reauth` になる。
