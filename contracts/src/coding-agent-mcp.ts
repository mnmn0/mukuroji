/**
 * Revision of the Public API surface that the coding agent MCP (`mcp.mjs`) relies on.
 *
 * A server build serves this revision, and an MCP build records the revision it was built against.
 * Increase it when the server adds an endpoint or field that a new MCP build needs, and record the
 * change in `CHANGELOG.md`.
 */
export const CODING_AGENT_MCP_API_REVISION = 5

/**
 * Oldest MCP API revision that a server build still serves.
 *
 * Increase it only with a breaking Public API change for the MCP, recorded in `CHANGELOG.md`, so
 * older MCP builds warn their users to update.
 */
export const CODING_AGENT_MCP_MINIMUM_API_REVISION = 1

/** Range of MCP API revisions a server build serves, reported by `GET /api/health`. */
export interface CodingAgentMcpCompatibility {
  /** Newest MCP API revision the server serves. */
  readonly apiRevision: number
  /** Oldest MCP API revision the server still serves. */
  readonly minimumApiRevision: number
}
