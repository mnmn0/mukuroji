import type {
  ConnectorCreateMutation,
  ConnectorExternalRecord,
  ConnectorOutboundMutation,
  ConnectorPage,
  ExternalResourceType,
} from './connectors'

/** One request a built-in resource protocol sends through the configured OAuth adapter. */
export type ConnectorProviderRequest = {
  /** HTTP method. */
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  /** Path relative to the configured API base URL, without a query string. */
  path: string
  /** Query parameters, encoded by the adapter. */
  query?: Readonly<Record<string, string>>
  /** JSON body. */
  body?: Record<string, unknown>
  /** Provider headers that hold no secret, such as `Prefer`. */
  headers?: Readonly<Record<string, string>>
  /** Error statuses the protocol handles itself instead of the adapter raising them. */
  allowedStatuses?: readonly number[]
}

/** Response of a {@link ConnectorProviderRequest}. */
export type ConnectorProviderResponse = {
  /** HTTP status. */
  status: number
  /** Parsed JSON body, or `undefined` when the body is empty. */
  payload: unknown
}

/**
 * Sends an authenticated request to the provider API. The adapter adds the bearer token, the
 * timeout, the size limit, and the error mapping.
 */
export type ConnectorProviderRequester = (
  request: ConnectorProviderRequest,
) => Promise<ConnectorProviderResponse>

/**
 * Provider-specific resource API of a built-in connector (ADR 0089). OAuth stays configured by the
 * operator; the protocol only reads and writes resources.
 */
export interface ConnectorResourceProtocol {
  /** Resource types the protocol serves; they must match the catalog entry. */
  readonly resourceTypes: readonly ExternalResourceType[]
  /** Reads one page of resources that Mukuroji manages. */
  pull(
    request: ConnectorProviderRequester,
    resourceType: ExternalResourceType,
    cursor?: string,
  ): Promise<ConnectorPage<ConnectorExternalRecord>>
  /** Writes a Work Item to an existing resource. */
  push(
    request: ConnectorProviderRequester,
    mutation: ConnectorOutboundMutation,
  ): Promise<ConnectorExternalRecord>
  /** Creates a resource for a Work Item; retrying the same operation returns the same resource. */
  create(
    request: ConnectorProviderRequester,
    mutation: ConnectorCreateMutation,
  ): Promise<ConnectorExternalRecord>
}
