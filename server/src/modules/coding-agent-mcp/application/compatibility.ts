import { CODING_AGENT_MCP_API_REVISION, type CodingAgentMcpCompatibility } from '@mukuroji/contracts'

/**
 * Version of the distributed coding agent MCP build (`mcp.mjs`), following semantic versioning.
 *
 * A release tag `mcp-v<version>` must match it, and `CHANGELOG.md` must have a section for it.
 */
export const CODING_AGENT_MCP_VERSION = '1.0.0'

/** Outcome of comparing this MCP build with the server it connects to. */
export type ServerCompatibilityStatus =
  /** The server serves this build's MCP API revision. */
  | 'compatible'
  /** The server predates this build's MCP API revision; update the server. */
  | 'server_outdated'
  /** The server no longer serves this build's MCP API revision; update the MCP. */
  | 'mcp_outdated'
  /** The server did not report its range, for example an older server or an unreachable one. */
  | 'unknown'

/** Compatibility between this MCP build and the server, safe to show to agents and people. */
export type ServerCompatibility = {
  /** Outcome of the comparison. */
  status: ServerCompatibilityStatus
  /** Human-readable explanation, including what to update when not compatible. */
  message: string
  /** Range the server reported, when it reported one. */
  server?: CodingAgentMcpCompatibility
}

/** Version information of this MCP build, returned by get_configuration. */
export type CodingAgentMcpBuild = {
  /** MCP build version. */
  version: string
  /** MCP API revision this build was built against. */
  apiRevision: number
}

/**
 * Describes this MCP build.
 *
 * @returns The build version and its MCP API revision.
 */
export function describeCodingAgentMcpBuild(): CodingAgentMcpBuild {
  return { version: CODING_AGENT_MCP_VERSION, apiRevision: CODING_AGENT_MCP_API_REVISION }
}

/**
 * Compares this MCP build's API revision with the range a server reported.
 *
 * @param server - Range from the server's health response, or undefined when it reported none.
 * @param apiRevision - MCP API revision of this build.
 * @returns The compatibility status and a message that names what to update.
 */
export function assessServerCompatibility(
  server: CodingAgentMcpCompatibility | undefined,
  apiRevision: number = CODING_AGENT_MCP_API_REVISION,
): ServerCompatibility {
  const build = `mukuroji MCP ${CODING_AGENT_MCP_VERSION} (MCP API revision ${apiRevision})`
  if (server === undefined) {
    return { status: 'unknown', message: `${build} could not read the server's supported MCP API revisions. The server may be older than this MCP or unreachable; some tools may fail.` }
  }
  const range = `${server.minimumApiRevision}-${server.apiRevision}`
  if (apiRevision > server.apiRevision) {
    return { status: 'server_outdated', server, message: `${build} needs a newer server: the server serves MCP API revisions ${range}. Ask an administrator to update Mukuroji, or use an older mcp.mjs.` }
  }
  if (apiRevision < server.minimumApiRevision) {
    return { status: 'mcp_outdated', server, message: `${build} is no longer supported by the server, which serves MCP API revisions ${range}. Download the latest mcp.mjs release.` }
  }
  return { status: 'compatible', server, message: `${build} is compatible with the server (MCP API revisions ${range}).` }
}
