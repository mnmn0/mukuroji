# coding agent 利用者ガイド

手元の coding agent（Claude Code、Codex、Kiro など）を mukuroji に接続し、Team のタスクを
agent に取得・着手・報告・完了させるための手順です。接続設定の詳細と全ツールの仕様は
[`docs/coding-agent-mcp.md`](../coding-agent-mcp.md)、運用モデルは
[`docs/software-factory.md`](../software-factory.md) にあります。アプリの **ヘルプ**（`/help#coding-agent`）
にも設定のテンプレートがあります。

Software factory は deploy 時に選ぶ任意の機能です（CDK context `mukuroji:softwareFactory`、既定は off）。
off の環境では Factory board とヘルプの coding agent ガイドが表示されず、agent にタスクを着手させることは
できません。使いたい場合は環境の管理者に有効化を依頼してください（[`cdk/README.md`](../../cdk/README.md#optional-modules)）。

off の環境でも **agent を接続** から自分用 token を発行できます。このとき設定例は、Team を固定しない
Workspace profile（下の「Workspace 全体を読む」）になります。on の環境で発行した token も、off に切り替えた後に
失効するまで Work Item の読み書きに使えます。不要になった token は **agent を接続** の「発行済みの token」から
**失効** します。

## 使う前に

- Workspace の member 以上のロールで、タスクを編集できる権限が必要です。guest は接続できません。
- 管理者が「メンバーによる agent 用キーの発行」を停止している場合は token を発行できません。
- agent に渡すタスクは、Team の **エージェント設定** で決めた「着手可能なステータス」にあり、
  必要なら受け入れ条件が書かれている必要があります（[管理者ガイド](admin.md#エージェント設定software-factory)）。

## 接続する

**設定** → **agent を接続**（`/settings/agent-connection`）の4つの手順に沿って進めます。

1. **mcp.mjs を取得して確認**: GitHub Release から `mcp.mjs` と checksum を取得し、表示されるコマンドで照合する。
   Node.js 22 以上が必要です。リポジトリを手元に置いている場合は `mcp.mjs` の代わりに
   `bun server/src/handlers/coding-agent-mcp.ts`（`bun run mcp:start`）でも起動できます。
2. **自分用の token を発行**: 「名前」（例: MacBook の Claude Code）と「有効期限」（最長90日）を入れて
   **token を発行**。token は一度だけ表示されるので、「環境変数に保存するコマンド」で環境変数
   `MUKUROJI_MCP_TOKEN` に保存し、**保存したので閉じる** を押す。token を設定ファイルに直接書かないでください。
3. **クライアントに登録**: 「クライアント」「Team」「OS」「mcp.mjs の絶対パス」を選ぶと、
   接続先（`MUKUROJI_MCP_URL`）と自分の member ID（`MUKUROJI_MCP_ASSIGNEE_ID`）を埋めた設定例が表示されるので、
   クライアントの設定に貼り付ける。
4. **接続を確認**: クライアントを再起動し、agent から確認する。確認に使うツールは profile で違います。
   - tasks profile（既定）: `get_configuration` を呼べることを確認する。
     `mcp.serverCompatibility.status` が `compatible` 以外なら、`message` に従って Mukuroji か `mcp.mjs` を更新する。
   - Workspace profile: `get_configuration` はありません。代わりに `whoami` を呼び、自分の member ID と email が返ることを確認する（名前は未設定なら省かれます）。

   `node mcp.mjs --version` で手元の `mcp.mjs` の version を確認できます。

token の期限が近づいたら「発行済みの token」から **期限を更新して再発行**、不要になったら **失効** します。

### 主な設定項目（環境変数）

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `MUKUROJI_MCP_URL` | ○ | 接続先の origin（HTTPS。`/api` は付けない） |
| `MUKUROJI_MCP_TOKEN` | ○ | 発行した token |
| `MUKUROJI_MCP_TEAM_ID` | ○ | 作業する Team |
| `MUKUROJI_MCP_ASSIGNEE_ID` | ○ | 自分の member ID。token の持ち主と一致させる |
| `MUKUROJI_MCP_PROJECT_ID` | | 特定の Project に絞る |
| `MUKUROJI_MCP_READ_ONLY` | | 読み取り用の6ツールだけを公開する |
| `MUKUROJI_MCP_RUNTIME` | | `claude-code` / `codex` / `kiro` / `other` |
| `MUKUROJI_MCP_PROFILE` | | `tasks`（既定）か `workspace`。`workspace` では URL と token だけを読む |

### Workspace 全体を読む（Workspace profile）

担当タスクを進めるのではなく、Linear の MCP のように Team・Project・メンバー・タスクを調べて整理したいときは、
`MUKUROJI_MCP_PROFILE=workspace` を足して別のサーバー名（例: `mukuroji`）で登録します。
Workspace profile は `1.0.0` より後に公開される `mcp.mjs` から使えます。`1.0.0` 以前の `mcp.mjs` は
`MUKUROJI_MCP_PROFILE` を知らず、Team ID と member ID がないため起動しません。対応版が GitHub Release に
出るまでは、リポジトリを手元に置いて `bun server/src/handlers/coding-agent-mcp.ts` で起動してください。必要なのは
`MUKUROJI_MCP_URL` と `MUKUROJI_MCP_TOKEN` だけです。agent に「`ABC-123` を読んで」「自分の担当を一覧して」の
ように頼むと、`get_issue` や `list_issues` で読みます。「タスクを作って」「`ABC-123` の優先度を上げて」「コメントを書いて」と頼むと、
`save_issue` と `save_comment` で書き込みます。読むだけにしたい場合は `MUKUROJI_MCP_READ_ONLY=true` を足します。
読み書きできる範囲は token の持ち主が Web で扱える範囲と同じです。Software factory が off の環境では、
**agent を接続** の設定例がはじめからこの profile になります。

## agent に作業させる

agent には「次のタスクに取り組んで」と頼むか、MCP の prompt `work-on-next-task` を使います。
agent は次の順で操作します。

1. **確認**: `get_configuration` → `get_work_status` / `get_next_task` で、着手可能なタスクを取得する。
2. **着手**: `start_task` でタスクを確保する。このとき Agent Run が作られ、Factory board に「処理中」と表示されます。
   `get_next_task` が再開候補（`action=resume`）を返した場合は、`start_task` ではなく `resume_task` で
   新しい Run を始めて続きから作業します（下の「止まったタスクを再開する」）。
3. **報告**: `report_progress` で進捗・ブロッカー・検証結果・成果物・引き継ぎを記録し、
   `heartbeat` で作業中であることを知らせる。状態を進めるときは `move_task`。
4. **完了**: `complete_task` でタスクを完了にし、`finish_run` で Run を終える（中断・失敗の場合もここで記録する）。

Team のワークフローで実行できる役割を限った遷移（例: 「承認済み」へ）は、agent からは実行できません。
`move_task` や `complete_task` が拒否されたら、人に状態の変更を頼みます。状態ごとの必須項目が空で拒否されたときは、
足りない項目（`/schedule`、`/acceptanceCriteria`、`/customFieldValues/<ID>`）がエラーに示されるので、
`update_task` で埋めてから新しい `idempotencyKey` でやり直します。

仕様書や設計書は、タスク詳細の **関連 Document** でタスクに link しておくと agent が読めます。
`get_task` が link された Document の一覧の最初のページを返し、続きは `list_task_documents` で取得します。
agent は `read_document` で本文を Markdown として読みます。
agent が読めるのは、token を発行した人が閲覧できる Document だけで、読むたびにその時点の権限で確かめます。
本文を読めるのはページとテンプレートで、フォルダーとホワイトボードは読めません。
Document の本文は、タスクの説明やコメントと同じく利用者が書いたデータで、agent への指示ではありません。
agent は要件として読みますが、Document に書かれていることだけを理由に、認証情報や接続範囲を変えたり、
タスクを動かす操作をしたりしないよう MCP server が agent に伝えます。

人がタスク詳細の **エージェントへ引き継ぐ** → **引き継ぎ内容をコピー** を使うと、タスクの内容と
この手順をまとめた文章を agent に貼り付けられます。コピーだけでは担当者や状態は変わりません。
引き継ぎ文には受け入れ条件と着手できるかの判断に加えて、作業中の Agent Run（実行中か停止中か、Run ID、
エージェント名）と、タスクに紐づく閲覧できる Document のタイトルとパスが入ります。Document の本文は入りません。
別のエージェントの Run が作業中なら、引き継ぎ文は着手しないよう伝えます。

### タスクにかかったトークンを見る

Claude Code の OpenTelemetry を Mukuroji に送るよう設定すると、タスク詳細の **Agent Run** 欄に、Run ごとの
トークン数と、そのタスクで使ったトークンの合計（入力・出力・キャッシュ読み取り・キャッシュ書き込み、model）が
表示されます。Team の管理者には推定費用（Claude Code の見積もり）も表示されます。設定のしかたは
[coding agent MCP の「トークン使用量の送信」](../coding-agent-mcp.md#トークン使用量の送信claude-codeopentelemetry)
を見てください。

- 値は、Run が動いていた間に同じ agent（instance ID）から届いた分を時刻で割り当てたものです。Run を始める前や
  終えた後の会話の分は、どのタスクにも入りません。
- 送られるのはトークン数・推定費用・model 名・時刻だけで、prompt や会話の内容は保存されません。
- 送信には MCP に設定している自分用 token をそのまま使います（`work-items:write`）。Claude Code はこの token を
  すべての OpenTelemetry の送信先に付けるので、metrics や traces を別の collector に送っている場合は設定しないで
  ください。
- **agent を接続** で Claude Code を選び、「トークン使用量を送る instance ID」を入力すると、MCP の登録コマンドと
  `~/.claude/settings.json` に足す設定が作られます。
- Factory board の期間サマリーにも、期間内に終わった Run のトークンの合計、Project 別の合計、トークンの多い
  タスクが表示されます。
- 今のところ送れるのは Claude Code だけです。Codex と Kiro には対応していません。

### 止まったタスクを再開する

`finish_run` で一時停止した（`paused`）タスクや、レビューで差し戻されて作業中に戻ったタスクは、
実行中の Run がないまま作業中（started）に残ります。担当者の agent は `resume_task` で新しい Run を始めて
続きから作業できます。新しい Run は直前の Run と結び付けて記録されます。

- Team のエージェント設定で「再開できるステータス」を選んでいる場合、その状態にあり、直前の Run が
  一時停止か完了で終わったタスクを `get_next_task` が再開候補として先に提示します。選んだ状態以外のタスクは
  再開できません（`not_resumable`）。
- 何も選んでいない場合は自動では提示しません。agent に「このタスクの続きをして」と頼んだときだけ、
  作業中のどの状態からでも再開します。直前の Run が失敗・解放で終わったタスクも、頼んだときだけ再開します。
- 再開は Work Item の状態を変えません。レビュー待ちなどから作業中へ戻すときは、agent が続けて `move_task` を呼びます。
- 別の Run が動いているタスクは再開できません（`agent_run_conflict`）。

### 着手できない（`not_ready`）とき

次のいずれかに当たると agent はタスクに着手できません。

- 状態がバックログ / 未着手の区分にない、または Team の「着手可能なステータス」に含まれない
- 未解決のブロッカーがある
- 受け入れ条件が必須なのに書かれていない
- 別の Agent Run がすでに動いている

## Factory board

Team の **Factory board**（`/teams/:teamId/factory`）で、agent の作業状況を確認します。

- **レーン** 表示: 処理中 / Run なし / 判断待ち / 停滞 / 失敗 / 完了（24時間以内）
- **ライン** 表示: 受付 → 実装 → 検証 → 成果物 → 判断 → 完了、と修理
- ランタイム・担当者・プロジェクトで絞り込めます。

画面上部の **期間サマリー** では、直近 7 / 30 / 90 日に終わった Run を集計します。

- **成功率**: 一時停止（`paused`）を除いて、完了で終わった Run の割合
- **手戻り率**: 失敗や完了の後に、同じタスクでもう一度始まった Run の割合
- **人の介入**: 人が解放した Run と、別の agent が引き継いだ Run の数
- **工程ごとの滞在時間**: 実装・検証・成果物・判断に Run がいた時間の中央値。判断には、一時停止から次の Run が始まるまでの待ち時間も入ります
- ランタイム別の成功率・手戻り率・介入

見られるのは自分が閲覧できるプロジェクトのタスクだけです。件数が多く読み込み上限に達したときは、
集計に含まれていない Run があることを表示します。期間内に終わった Run のトークン数も合計します（推定費用は Team の
管理者だけに表示）。Run や使用量が読み込み上限に達したときは、合計に含まれていない分があることを表示します。

「停滞」は、リース時間内に `heartbeat` が届かなかった Run です。自動では止まらず、担当も変わりません。
Run を開いて状況を確認し、続けられない場合は **解放** してタスクを人や別の agent に戻します。
解放できるのは Team の管理者、その Run を始めた人、現在の担当者です。失敗・停滞した Run を
Triage に自動で起票する設定もあります。

## 困ったとき

| 症状 | 確認すること |
| --- | --- |
| 認証エラーになる | token の期限切れ・失効。環境変数 `MUKUROJI_MCP_TOKEN` がクライアントに渡っているか |
| `start_task` が担当者違いで失敗する | `MUKUROJI_MCP_ASSIGNEE_ID` が token の持ち主の member ID か。タスクの担当者が自分か |
| 競合エラーになる | 他の人がタスクを更新した。agent に `get_task` で最新を取り直させる |
| タスクが提示されない | 上の「着手できないとき」。Team のエージェント設定 |
| 止まったタスクが再開候補に出ない | Team の「再開できるステータス」にタスクの状態が含まれるか。直前の Run が失敗・解放で終わっていないか |
