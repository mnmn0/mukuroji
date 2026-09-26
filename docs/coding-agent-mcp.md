# Coding Agent MCP

Mukurojiのタスクをコーディングエージェントから操作するstdio MCPです。
タスク・ワークフロー・コメントの正本はMukurojiにあり、Web画面とエージェントが同じ状態を参照します。
MCPプロセスは公開APIへ接続するクライアントとして動作するため、AWS認証情報やDynamoDBへの直接アクセスは不要です。

## 接続

1. この変更のコメントAPIを含むMukurojiサーバーを用意します。既存環境への反映には通常のサーバーリリースが必要です。新規テーブルやデータ移行はありません。
2. WorkspaceのDeveloper設定から `work-items:read` と `work-items:write` を持つAPIキーを作成します。キー所有者には対象Team/Projectへの閲覧・編集権限が必要です。OAuth access tokenも利用できますが、このMCPはtokenの自動更新を行いません。
3. エージェントが担当する既存WorkspaceメンバーのIDとTeam IDを指定します。`ASSIGNEE_ID` は任意のエージェント名ではありません。表示用のエージェント名は `AGENT_NAME` で別途指定します。
4. リポジトリルートで `bun install --frozen-lockfile` を実行し、MCPクライアントに次の起動設定を登録します。

`mcpServers` 形式に対応するクライアントでの例です。パス・URL・IDは実際の値に置き換えます。
tokenはクライアントの秘密情報設定または子プロセスへ引き継ぐ環境変数で渡し、共有設定ファイルには保存しません。

```json
{
  "mcpServers": {
    "mukuroji-tasks": {
      "command": "/absolute/path/to/bun",
      "args": ["/absolute/path/to/mukuroji/server/src/handlers/coding-agent-mcp.ts"],
      "env": {
        "MUKUROJI_MCP_URL": "https://your-mukuroji.example.com",
        "MUKUROJI_MCP_TEAM_ID": "your-team-id",
        "MUKUROJI_MCP_ASSIGNEE_ID": "your-workspace-member-id",
        "MUKUROJI_MCP_AGENT_NAME": "coding-agent"
      }
    }
  }
}
```

起動する子プロセスの環境に `MUKUROJI_MCP_TOKEN` を設定してください。
GUIクライアントはターミナルの環境変数を引き継がない場合があるため、クライアント側で環境変数を渡す必要があります。
コマンド・引数・環境変数を個別入力するクライアントでも同じ値を使えます。
コマンドラインで起動を確認する場合は、環境変数を設定して `bun run mcp:start` を実行します。
stdioで要求を待つため、正常起動時に通常の画面出力はありません。

| 環境変数 | 必須 | 用途 |
| --- | --- | --- |
| `MUKUROJI_MCP_URL` | 必須 | Mukurojiのorigin。`/api` を含めず、HTTPSを使用。開発時はloopbackのみHTTP可 |
| `MUKUROJI_MCP_TOKEN` | 必須 | APIキーまたは有効なOAuth access token |
| `MUKUROJI_MCP_TEAM_ID` | 必須 | この接続で扱うTeam |
| `MUKUROJI_MCP_ASSIGNEE_ID` | 必須 | 作業選択・作成・更新の対象となる担当メンバー |
| `MUKUROJI_MCP_PROJECT_ID` | 任意 | 全操作を一つのProjectに限定 |
| `MUKUROJI_MCP_AGENT_NAME` | 任意 | コメントに付ける表示名。既定 `coding-agent`、最大64文字 |
| `MUKUROJI_MCP_READ_ONLY` | 任意 | `true` で読み取り6ツールのみ公開。既定 `false` |

配布用には `bun run mcp:build` で `server/dist/mcp.mjs` を生成できます。
このファイルはBunで起動します。設定変更・token更新時はMCPプロセスを再起動してください。

## 操作

| ツール | 用途 |
| --- | --- |
| `get_configuration` | 接続先Team・担当者、利用可能なType、status ID、必須custom fieldを確認 |
| `list_tasks` | 権限内のタスクを担当者・Project・Type・statusで絞り込み、ページ取得 |
| `get_task` | タスク本文・revision・現在状態と、未解決blockerの件数を取得 |
| `get_next_task` | 設定された担当者の作業中タスクを優先表示し、未着手なら次の候補を選択 |
| `get_work_status` | 担当タスクの未着手・作業中・完了・取り消し件数と作業中一覧 |
| `list_progress` | タスクのcanonicalコメント・返信を新しい順にページ取得 |
| `create_task` | 担当者付きタスクを作成。期限省略時は未スケジュール |
| `update_task` | タイトル・説明・優先度・custom fieldをrevision付きで更新 |
| `start_task` | backlog/unstartedからstartedへ遷移。blockerを再確認し、同時更新をCASで排除 |
| `move_task` | 作業中から同じstartedカテゴリーの「レビュー中」「ブロック中」などへ移動 |
| `report_progress` | 進捗・問題・テスト結果・PRリンクを、エージェント名付きコメントとして保存 |
| `complete_task` | startedからcompletedへ遷移 |
| `reopen_task` | completed/canceledからbacklog/unstartedへ戻す |
| `cancel_task` | 未完了タスクをcanceledへ遷移 |

読み取りはcredentialの現在の権限範囲、更新はさらに設定された担当メンバーのタスクに限定します。
コメントにも設定されたProject・担当者の制約を公開APIへ渡し、保存時と再送時に検証します。担当変更は通常のMukuroji画面/APIで行います。複数エージェントで作業を分ける場合は担当メンバーやProjectを分けて設定できます。

## エージェントの作業手順

1. `get_configuration` でstatus IDと必須fieldを確認します。`started` 等は共通カテゴリー名であり、status IDとは限りません。
2. `get_work_status` と `get_next_task` を呼びます。候補は優先度 high→medium→low、期限の早い順（未設定は後）、作成日時、IDの順です。完了・取り消し・archive済みタスクは新規候補から除外します。
3. `action: in_progress` は作業中という情報であり、別エージェントからの引き継ぎ許可ではありません。自分が着手済みの作業、またはユーザーから明示的に引き継いだ作業だけを再開します。
4. `action: start` の場合、候補の `revision`、startedカテゴリーの `workflowStatusId`、新規UUIDの `idempotencyKey` を `start_task` に渡します。成功後に作業を開始します。候補取得だけでは着手済みになりません。
5. `report_progress` に実装方針・進捗・blocker・検証結果・成果物リンクを記録します。タスクの説明は変更しません。既存コメントは `list_progress` で読みます。
6. レビュー待ちなどは該当するstatusを設定し、要求と必要な検証が満たされたら `complete_task` を呼びます。進捗コメントだけでは完了になりません。

例（IDとrevisionは実際の取得結果を使います）:

```json
{
  "taskId": "task-123",
  "expectedRevision": 7,
  "workflowStatusId": "in-progress",
  "idempotencyKey": "b7322cfb-1d1f-46df-a44b-8e3c4201f8cb"
}
```

`work-on-next-task` promptと `mukuroji://agent/workflow` resourceにも同じ運用ガイドを公開します。
Webのタスク一覧・詳細から状態とコメントを確認できます。表示の更新タイミングは既存画面の再取得に従います。

## 競合・再送・制約

- 更新には取得時の `expectedRevision` を必須とし、競合を自動上書きしません。`start_task` が同じrevisionに対して並行実行された場合、成功する更新は一つです。
- mutationは操作ごとのUUIDを要求します。通信切断などで結果が不明なら**同じ引数・同じkey**で再送します。異なる入力に同じkeyを使うと競合になります。エラー後に新しいkeyを作って再送しません。
- `conflict` で正当な新しい操作が必要になった場合は、タスクを再取得して変更を確認し、新しいrevisionと新しいkeyを使います。
- `blockedBy` の依存先がcompleted以外、閲覧不可、設定Projectの範囲外、または削除済みなら新規着手を拒否します。依存確認は読み取り時点の判定であり、複数タスクをまたぐロックではありません。ワークフロー遷移や承認条件はサーバーが最終検証します。
- キュー探索は通常50件/ページです。応答が2 MiBを超える場合は10→2→1件へ縮小し、ページサイズに紐づくcursorを再利用せず最初から読み直します。探索は各試行で最大1,000件分（空ページ分を含む）、候補選択中の依存先照会は最大100件です。上限到達やAPIエラーは「作業なし」に置き換えずエラーを返します。Project/Typeを絞り込んでください。
- `idempotency_conflict` で `retryable: true` の場合は元の操作が処理中です。同じ引数・同じkeyだけで再送してください。通常のrevision競合とは区別します。
- HTTP応答は2 MiB、各requestは15秒まで。ページ一覧では `hasMore: true` の間、空ページでも同じfilter/limitと `nextCursor` で続けます。
- `401` はtokenの期限・失効、`403` はscope/RBAC、`429` はrate limitを確認します。`retryAfterSeconds` があればその時間を待ちます。秘密情報を含み得る上流エラー本文はMCPへ転送しません。
- `report_progress` は最大3900文字です。長い報告は複数コメントへ分けます。`update_task.description` は公開APIの制約に合わせ最大4096文字です。
- コメントAPIはcanonical Collaboration保存先を読みます。未移行のlegacy eventコメントの互換fallbackは含みません。新しい進捗コメントは常にcanonical保存先に入ります。
- コメントの日時順を保証するため、旧形式・互換用のCollaboration索引を最大2,000行分走査します。この上限を超える大きな履歴は `503` になり、不完全な順序を成功として返しません。
- タスク状態を共有する機能です。エージェントの停止・切断監視、heartbeat、作業の自動実行、切断時の状態変更は行いません。不要になった作業は意図を確認して再オープン・取り消しなどで更新します。

## 検証

```sh
bun test server/src/modules/coding-agent-mcp server/src/app/composition/coding-agent-mcp.test.ts
bun run server:test
bun run typecheck:server
bun run typecheck:contracts
bun run dependencies:check
bun run knip:check
bun run api:contract:check
bun run mcp:build
```

stdioの結合テストはloopback HTTPサーバーと公式MCPクライアントを起動し、旧プロトコル互換・新プロトコル、ツール発見、着手、進捗記録、完了、read-only設定を検証します。実際のAWS・本番APIキーは使いません。
MCP SDKの利用方法は[公式TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server)に従います。
