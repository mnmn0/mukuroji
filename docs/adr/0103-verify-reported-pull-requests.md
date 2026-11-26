# 0103. agent が報告した pull request を Workspace の connector で照会し、状態を保存する

- 状態: 提案
- 日付: 2026-11-26
- 関連: Issue #353、ADR 0102

## 背景

agent は `report_progress` の `artifacts` に pull request の URL を載せる。Web はその URL を
リンクとして表示するだけで、pull request が本当にあるのか、check が通ったのか、merge されたのかは
人が開いて確かめるしかなかった。URL は agent が書いた文字列なので、存在しない URL や
別の repository の URL でも、確かめた成果物のように見える。

Workspace には GitHub の connector（ADR 0102 で残した、同期のある provider）があり、
credential の復号・更新と、失敗時の degraded / needs-reauth の扱いがそろっている。

## 決定

- 照会は Workspace の connector だけで行う。agent や利用者の token は使わない。
  `ConnectorSyncEngine.readPullRequest` が、同期と同じ credential の扱いで GitHub の
  pull request、check run と commit status、review を読む。
- 照会するのは、Work Item の新しい report から集めた pull request の URL のうち、
  `github.com/<owner>/<repo>/pull/<n>` と `gitlab.com/.../-/merge_requests/<n>` の形のものだけで、
  最大 20 件。GitLab は形だけ認識し、`unsupported-provider` として未確認にする。
- Team の Agent settings に `artifactRepositories`（`owner/repo` の一覧、最大 50）を足す。
  空なら connector が読める repository をすべて照会し、指定があればそれ以外は照会せず
  `repository-not-allowed` とする。既存の設定は空として読むので、移行は要らない。
- 照会結果は Agent Runs table の Work Item の partition に保存する。
  - 状態の row: `recordKey = agent-run-artifact#<sha256(workItemId)>#<sha256(url)>`。
    `checkedAt` が新しいときだけ上書きする条件付き書き込みにする。
  - 照会の claim の row: `recordKey = agent-run-artifact-refresh#<sha256(workItemId)>`。
    同じ Work Item の照会は 1 分に 1 回までにし、複数の閲覧者が同時に開いても provider への呼び出しを増やさない。
- 照会は Web の `GET /api/teams/:teamId/work-items/:workItemId/artifact-statuses` を開いたときに行う。
  閲覧権限は Work Item の viewer と同じ。保存した状態が 2 分より古い open の pull request だけを読み直し、
  merge 済みは読み直さない。provider が一時的に読めないときは、前回確認できた状態を残す。
- 未確認の理由は `repository-not-allowed`、`no-connector`、`not-accessible`、`unsupported-provider`、
  `unavailable` の 5 つ。Web は未確認の pull request に「未確認」と理由を出し、確認済みのものと区別する。

## 検討した選択肢

- **GitHub webhook で状態を受ける。** 更新が速く、閲覧時の呼び出しがない。ただし webhook の受け口・署名検証・
  repository ごとの設定が要り、今の connector には webhook がない。閲覧時の照会で始め、webhook は後で足す。
- **定期 polling で全 Work Item の状態を更新する。** 画面を開く前に最新になる。ただし見られない Work Item の分も
  rate limit を使う。閲覧時の照会と 1 分の claim で、呼び出しを見られる分だけにした。
- **agent の token で照会する。** 追加の接続が要らない。ただし Workspace の外の権限で読むことになり、
  利用者に見える結果が agent ごとに変わる。Workspace の connector に限った。

## 結果

- 閲覧者は、report の pull request が実在するか、check・review・merge の状態を Work Item の会話で見られる。
- Workspace に GitHub の接続がなければ、すべて「未確認（接続なし）」になる。
- Public API と MCP の `get_task` にはまだ出さない。出すときは、閉じた response schema を壊さないよう
  新しい endpoint として足す。
- webhook による更新、未閲覧の Work Item の polling、GitLab の照会は後続とする。
