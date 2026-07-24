import type {
  ApiKeyPort,
  AuthenticateCredentialRequest,
  CreateApiKeyRequest,
  CreateOAuthAppRequest,
  IssueOAuthTokenRequest,
  OAuthCredentialPort,
  RevokeApiKeyRequest,
  RevokeOAuthAppRequest,
  RotateApiKeyRequest,
  RotateOAuthClientSecretRequest,
} from '../../application/ports'

/** Focused adapter that exposes only API key operations from a storage implementation. */
export class ApiKeyAdapter implements ApiKeyPort {
  /** Storage implementation that owns API key records. */
  readonly #source: ApiKeyPort

  /** Creates a focused API key adapter. */
  constructor(source: ApiKeyPort) {
    this.#source = source
  }

  /** Creates an API key. */
  createApiKey(request: CreateApiKeyRequest) {
    return this.#source.createApiKey(request)
  }

  /** Lists API keys. */
  listApiKeys(workspaceId: string) {
    return this.#source.listApiKeys(workspaceId)
  }

  /** Rotates an API key. */
  rotateApiKey(request: RotateApiKeyRequest) {
    return this.#source.rotateApiKey(request)
  }

  /** Revokes an API key. */
  revokeApiKey(request: RevokeApiKeyRequest) {
    return this.#source.revokeApiKey(request)
  }

  /** Authenticates an API key. */
  authenticateApiKey(request: AuthenticateCredentialRequest) {
    return this.#source.authenticateApiKey(request)
  }
}

/** Focused adapter that exposes only OAuth credential operations. */
export class OAuthCredentialAdapter implements OAuthCredentialPort {
  /** Storage implementation that owns OAuth application and token records. */
  readonly #source: OAuthCredentialPort

  /** Creates a focused OAuth credential adapter. */
  constructor(source: OAuthCredentialPort) {
    this.#source = source
  }

  /** Creates an OAuth application. */
  createOAuthApp(request: CreateOAuthAppRequest) {
    return this.#source.createOAuthApp(request)
  }

  /** Lists OAuth applications. */
  listOAuthApps(workspaceId: string) {
    return this.#source.listOAuthApps(workspaceId)
  }

  /** Rotates an OAuth client secret. */
  rotateOAuthClientSecret(request: RotateOAuthClientSecretRequest) {
    return this.#source.rotateOAuthClientSecret(request)
  }

  /** Revokes an OAuth application. */
  revokeOAuthApp(request: RevokeOAuthAppRequest) {
    return this.#source.revokeOAuthApp(request)
  }

  /** Issues an OAuth access token. */
  issueOAuthToken(request: IssueOAuthTokenRequest) {
    return this.#source.issueOAuthToken(request)
  }

  /** Authenticates an OAuth access token. */
  authenticateOAuthToken(request: AuthenticateCredentialRequest) {
    return this.#source.authenticateOAuthToken(request)
  }
}
