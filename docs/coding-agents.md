# Coding agent の環境（Codex / Claude Code / Kiro）

mukuroji の開発で coding agent を使うときの準備です。どの agent でも、規則は `AGENTS.md`、
push 前レビューは trusted な `main` から導入した `mukuroji-review` Skill を使います。

| | Codex | Claude Code | Kiro |
| --- | --- | --- | --- |
| 規則の読み込み | `AGENTS.md` | `CLAUDE.md`（`@AGENTS.md` を取り込む） | `.kiro/steering/mukuroji.md`（`AGENTS.md` を参照） |
| Skill の導入先 | `$CODEX_HOME/skills/mukuroji-review` | `~/.claude/skills/mukuroji-review` | `~/.kiro/skills/mukuroji-review` |
| MCP 設定 | `.codex/config.toml` | `.mcp.json`（`.mcp.json.example` をコピー） | `.kiro/settings/mcp.json` |

## 1. 環境の用意

Bun の version は `package.json` の `packageManager` に固定されています。次のスクリプトが
その version の Bun を導入し、依存を `bun install --frozen-lockfile` で入れます。
agent に依らず使えます。

```sh
bash scripts/codex-setup.sh
```

- Codex cloud: カスタムセットアップスクリプトに上の行を指定します。
- Claude Code の cloud 環境: 環境設定の setup script に上の行を指定します。
- ローカル（Claude Code / Kiro）: リポジトリルートで一度実行します。

検証まで実行したい場合は `CODEX_VALIDATE=1 bash scripts/codex-setup.sh` を使います。

## 2. review Skill の導入と照合

Skill の source は `.codex/skills/mukuroji-review` です。この場所は agent の
repository-scoped Skill の自動検出先ではありません。branch 上の変更が reviewer
instructions を書き換えないよう、Skill はリポジトリの外（personal scope）へ、trusted な
`origin/main` の固定 commit から導入します。

`scripts/sync-review-skill.sh` は `origin/main` を fetch してその commit OID を固定し、
`git archive` でその commit の Skill tree だけを取り出します。working tree の Skill は
読みません。スクリプト自体も branch で変えられるため、作業 branch 上では
**`origin/main` の版を実行**します。

```sh
git fetch origin main
# 導入・更新（既存の copy は置き換え、失敗時は元に戻す）
git show origin/main:scripts/sync-review-skill.sh | bash -s -- install claude   # Claude Code
git show origin/main:scripts/sync-review-skill.sh | bash -s -- install kiro     # Kiro
git show origin/main:scripts/sync-review-skill.sh | bash -s -- install codex    # Codex

# push 前レビューの直前に照合（標準出力に照合した commit OID を出す）
git show origin/main:scripts/sync-review-skill.sh | bash -s -- check claude
```

`check` が失敗した場合（未導入・差分あり）は、`AGENTS.md` のとおりレビューを失敗扱いにして
push しません。`install` で trusted source から更新してからやり直します。照合で出た commit
OID はレビューの記録に残します。導入先は `claude` / `kiro` / `codex` のほか、リポジトリ外の
絶対パスも指定できます。

### Claude Code

`~/.claude/skills/mukuroji-review` に導入すると、Claude Code は personal Skill として
自動で読み込みます。push 前レビューでは `check claude` が通ったことを確かめてから
`mukuroji-review` Skill を使います。観点別のサブエージェントは Agent ツールで起動できます。

### Kiro

Kiro はワークスペースの `.kiro/steering/mukuroji.md` を常に読み込み、そこから
`AGENTS.md` を参照します。Skill は `~/.kiro/skills/mukuroji-review` に導入し、
`check kiro` が通った後に、その `SKILL.md` と `references/` を読んでレビューします。

### Codex

これまでどおり Codex の Skill installer（repository `mnmn0/mukuroji`、path
`.codex/skills/mukuroji-review`、ref `main`）でも導入できます。`check codex` で同じ照合が
できます。

## 3. Mukuroji の MCP server に接続する

タスクの取得・着手・進捗報告を agent から行う場合の設定です。詳細と各環境変数の意味は
[Coding Agent MCP](coding-agent-mcp.md) にあります。

Claude Code では `.mcp.json.example` を `.mcp.json` にコピーし、Claude Code を起動する
シェルで `MUKUROJI_MCP_URL`、`MUKUROJI_MCP_TOKEN`、`MUKUROJI_MCP_TEAM_ID`、
`MUKUROJI_MCP_ASSIGNEE_ID` を設定します。token は `.mcp.json` に書きません。
Codex と Kiro の設定例は [Coding Agent MCP](coding-agent-mcp.md#クライアント別の設定例) を
参照してください。
