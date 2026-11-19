# Changelog

Mukuroji が配布する coding agent MCP（`mcp.mjs`）と、MCP が使う server API の変更を記録します。
形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に、MCP の version は
[Semantic Versioning](https://semver.org/lang/ja/) に従います。

## 記録のしかた

- MCP の tool、引数、結果、または MCP が呼ぶ Public API を変えた PR は、`## [Unreleased]` に
  `Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security` のどれかで1行ずつ書きます。
- server API の破壊的変更と非推奨は、MCP の変更がなくても必ず書きます。
- 新しい MCP build が新しい server API を必要とするときは
  `contracts/src/coding-agent-mcp.ts` の `CODING_AGENT_MCP_API_REVISION` を上げ、
  古い MCP を server が受け付けなくなるときは `CODING_AGENT_MCP_MINIMUM_API_REVISION` を上げます。
  どちらも変えたことをこのファイルに書きます。
- Release するときは `server/src/modules/coding-agent-mcp/application/compatibility.ts` の
  `CODING_AGENT_MCP_VERSION` を上げ、`## [Unreleased]` の内容を `## [<version>] - <YYYY-MM-DD>` に移します。
  tag `mcp-v<version>` の Release note は、この section から作られます
  （`bun run mcp:release-notes -- --tag mcp-v<version>`）。

## [Unreleased]

## [1.0.0]

最初の versioned release です。MCP API revision 1 を使います。

### Added

- `node mcp.mjs --version` で MCP の version を表示します。起動時には version と MCP API revision を stderr に出します。
- MCP の `serverInfo.version` と `get_configuration` の `mcp` に、MCP の version、MCP API revision、server との互換性を返します。
- server の `GET /api/health` が、受け付ける MCP API revision の範囲を `codingAgentMcp` で返します。
  MCP は起動時にこれを読み、範囲外または読めないときに警告します。
- `bun run mcp:build` が `mcp.mjs.sha256` も生成します。
