import type {
  ApiKeySummary,
  ApiScope,
  CreateApiKeyInput,
  CreateOAuthAppInput,
  OAuthAppSummary,
} from '@mukuroji/contracts'
import type { IdempotentDomainMutationRequest } from './request-control-port'

/** Request used to create an API key. */
export type CreateApiKeyRequest = IdempotentDomainMutationRequest & {
  /** Workspace that owns the API key. */
  workspaceId: string
  /** User creating the API key. */
  createdByUserId: string
  /** Validated API key input. */
  input: CreateApiKeyInput
}

/** API key creation or rotation result containing the one-time secret. */
export type ApiKeySecretResult = {
  /** Secret-free API key summary. */
  apiKey: ApiKeySummary
  /** High-entropy secret returned only once. */
  secret: string
}

/** Request used to rotate an API key. */
export type RotateApiKeyRequest = IdempotentDomainMutationRequest & {
  /** Workspace that owns the API key. */
  workspaceId: string
  /** API key to rotate. */
  apiKeyId: string
}

/** Request used to revoke an API key. */
export type RevokeApiKeyRequest = RotateApiKeyRequest

/** Common request used to authenticate a developer credential. */
export type AuthenticateCredentialRequest = {
  /** Bearer credential supplied by the caller. */
  credential: string
  /** Scopes required by the endpoint. */
  requiredScopes?: readonly ApiScope[]
}

/** Authenticated developer credential snapshot. */
export type AuthenticatedDeveloperCredential = {
  /** Authentication mechanism. */
  kind: 'api-key' | 'oauth-token'
  /** Workspace that owns the credential. */
  workspaceId: string
  /** API key or OAuth token identifier. */
  credentialId: string
  /** Subject whose current membership and RBAC must be evaluated. */
  subjectUserId: string
  /** Issuing OAuth application when the credential is a token. */
  oauthAppId?: string
  /** Scopes granted to the credential. */
  scopes: ApiScope[]
  /** Credential expiry timestamp when one exists. */
  expiresAt?: string
}

/** Request used to create an OAuth application. */
export type CreateOAuthAppRequest = IdempotentDomainMutationRequest & {
  /** Workspace that owns the OAuth application. */
  workspaceId: string
  /** User creating the OAuth application. */
  createdByUserId: string
  /** Validated OAuth application input. */
  input: CreateOAuthAppInput
}

/** OAuth application creation or rotation result containing the one-time secret. */
export type OAuthAppSecretResult = {
  /** Secret-free OAuth application summary. */
  oauthApp: OAuthAppSummary
  /** Client secret returned only once. */
  clientSecret: string
}

/** Request used to rotate an OAuth client secret. */
export type RotateOAuthClientSecretRequest = IdempotentDomainMutationRequest & {
  /** Workspace that owns the OAuth application. */
  workspaceId: string
  /** OAuth application to rotate. */
  oauthAppId: string
}

/** Request used to revoke an OAuth application. */
export type RevokeOAuthAppRequest = RotateOAuthClientSecretRequest

/** OAuth client-credentials token request. */
export type IssueOAuthTokenRequest = {
  /** Public OAuth client identifier. */
  clientId: string
  /** Client secret supplied by the caller. */
  clientSecret: string
  /** Optional subset of the application's scopes. */
  scopes?: readonly ApiScope[]
  /** Requested token lifetime in seconds. */
  expiresInSeconds?: number
}

/** OAuth token endpoint result. */
export type OAuthTokenResult = {
  /** Bearer access token returned only once. */
  accessToken: string
  /** OAuth token type. */
  tokenType: 'Bearer'
  /** Token lifetime in seconds. */
  expiresIn: number
  /** Token expiry timestamp. */
  expiresAt: string
  /** Scopes granted to the token. */
  scopes: ApiScope[]
}

/** Application port for API key lifecycle and authentication. */
export interface ApiKeyPort {
  /** Creates an API key and returns its secret once. */
  createApiKey(request: CreateApiKeyRequest): Promise<ApiKeySecretResult>
  /** Lists secret-free API key summaries for a workspace. */
  listApiKeys(workspaceId: string): Promise<ApiKeySummary[]>
  /** Rotates an API key and returns its replacement secret once. */
  rotateApiKey(request: RotateApiKeyRequest): Promise<ApiKeySecretResult>
  /** Revokes an API key. */
  revokeApiKey(request: RevokeApiKeyRequest): Promise<ApiKeySummary>
  /** Authenticates an API key and updates its last-used timestamp. */
  authenticateApiKey(
    request: AuthenticateCredentialRequest,
  ): Promise<AuthenticatedDeveloperCredential>
}

/** Application port for OAuth application and token credentials. */
export interface OAuthCredentialPort {
  /** Creates an OAuth application and returns its client secret once. */
  createOAuthApp(request: CreateOAuthAppRequest): Promise<OAuthAppSecretResult>
  /** Lists secret-free OAuth applications for a workspace. */
  listOAuthApps(workspaceId: string): Promise<OAuthAppSummary[]>
  /** Rotates an OAuth application's client secret. */
  rotateOAuthClientSecret(
    request: RotateOAuthClientSecretRequest,
  ): Promise<OAuthAppSecretResult>
  /** Revokes an OAuth application and its tokens. */
  revokeOAuthApp(request: RevokeOAuthAppRequest): Promise<OAuthAppSummary>
  /** Issues a client-credentials access token. */
  issueOAuthToken(request: IssueOAuthTokenRequest): Promise<OAuthTokenResult>
  /** Authenticates an OAuth access token. */
  authenticateOAuthToken(
    request: AuthenticateCredentialRequest,
  ): Promise<AuthenticatedDeveloperCredential>
}
