# Architecture Decision Records（ADR）

設計判断とその理由を、後から読む人が「なぜこうなっているか」を辿れるように1判断1ファイルで残します。
`docs/*.md` の各文書は「現在の契約」を書く場所で、ADR は「その契約を選んだ時点の判断」を書く場所です。

## いつ書くか

次のどれかに当たる変更では、PR に ADR を含めます。

- workspace・module の境界や依存方向を変える
- DynamoDB の table・key 設計、queue・stream・worker の構成を追加・変更する
- 認証・認可・tenancy の仕組みを変える
- 外部サービス（AWS サービス、IdP、LLM など）を新しく採用する、またはやめる
- 一度決めたことを覆す（元の ADR は `置き換え済み` にして新しい ADR から参照する）

小さなバグ修正や、既存の判断の範囲内に収まる機能追加には不要です。

## 書き方

1. [`0000-template.md`](0000-template.md) を `NNNN-短い-kebab-case.md` としてコピーする。
   `NNNN` は既存の最大番号 + 1 の4桁です。
2. 状態は `提案` で PR を出し、マージ時に `採用` にする。
3. 採用後の ADR は書き換えません。判断が変わったら新しい ADR を作り、古い方の状態を
   `置き換え済み（NNNN）` に変えるだけにします。

## 一覧

| 番号 | タイトル | 状態 |
| --- | --- | --- |
| [0001](0001-record-architecture-decisions.md) | 設計判断を ADR として記録する | 採用 |
| [0003](0003-agent-run-latest-record.md) | Work Item ごとの最新 Run を `agent-run-latest` row で強整合に持つ | 採用 |
| [0004](0004-public-api-caller-identity.md) | Public API の rate limit・冪等性の呼び出し元を OAuth app 単位にする | 提案 |
| [0005](0005-time-period-close-record.md) | 工数の月次締めを Team ごとの `TIME_CLOSE` row で持つ | 提案 |
