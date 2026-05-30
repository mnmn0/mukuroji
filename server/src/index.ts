import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Context } from 'hono'

type AuthTokenSet = {
  AccessToken?: string
  IdToken?: string
  RefreshToken?: string
  ExpiresIn?: number
  TokenType?: string
}

type InitiateAuthResponse = {
  AuthenticationResult?: AuthTokenSet
  ChallengeName?: string
  Session?: string
}

type ListUserPoolsResponse = {
  UserPools?: Array<{
    Id?: string
    Name?: string
  }>
}

type ListUserPoolClientsResponse = {
  UserPoolClients?: Array<{
    ClientId?: string
    ClientName?: string
  }>
}

type GetUserResponse = {
  Username?: string
  UserAttributes?: Array<{
    Name?: string
    Value?: string
  }>
}

type CognitoErrorPayload = {
  __type?: string
  message?: string
  Message?: string
}

type LoginRequestBody = {
  email?: unknown
  password?: unknown
}

type CognitoClient = {
  initiatePasswordAuth(email: string, password: string): Promise<InitiateAuthResponse>
  getUser(accessToken: string): Promise<GetUserResponse>
}

const app = new Hono()
let cognito: CognitoClient

app.use(
  '/api/*',
  cors({
    origin: [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:6006',
      'http://127.0.0.1:6006',
    ],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
  }),
)

app.get('/', (c) => {
  return c.text('mukuroji API')
})

app.get('/api/health', (c) => {
  return c.json({ ok: true })
})

app.post('/api/auth/login', async (c) => {
  const body = await readJson<LoginRequestBody>(c.req)
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''

  if (!email || !password) {
    return c.json({ message: 'Email and password are required.' }, 400)
  }

  try {
    const response = await cognito.initiatePasswordAuth(email, password)
    const tokens = response.AuthenticationResult

    if (!tokens?.AccessToken) {
      return c.json(
        {
          message: response.ChallengeName
            ? `Unsupported Cognito challenge: ${response.ChallengeName}`
            : 'Cognito did not return an access token.',
        },
        409,
      )
    }

    return c.json({
      accessToken: tokens.AccessToken,
      idToken: tokens.IdToken,
      refreshToken: tokens.RefreshToken,
      expiresAt: Date.now() + (tokens.ExpiresIn ?? 3600) * 1000,
      tokenType: tokens.TokenType ?? 'Bearer',
    })
  } catch (error) {
    return toAuthErrorResponse(c, error)
  }
})

app.get('/api/auth/me', async (c) => {
  const authorization = c.req.header('Authorization') ?? ''
  const accessToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1]

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const user = await cognito.getUser(accessToken)

    return c.json({
      username: user.Username ?? '',
      attributes: Object.fromEntries(
        (user.UserAttributes ?? [])
          .filter((attribute) => attribute.Name && attribute.Value !== undefined)
          .map((attribute) => [attribute.Name as string, attribute.Value]),
      ),
    })
  } catch (error) {
    return toAuthErrorResponse(c, error)
  }
})

async function readJson<T>(request: { json: () => Promise<T> }) {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

function toAuthErrorResponse(c: Context, error: unknown) {
  if (!(error instanceof CognitoServiceError)) {
    console.error(error)
    return c.json({ message: 'Unexpected authentication error.' }, 500)
  }

  if (error.code === 'NotAuthorizedException' || error.code === 'UserNotFoundException') {
    return c.json({ message: 'Invalid email or password.' }, 401)
  }

  if (error.code === 'ResourceNotFoundException' || error.code === 'ClientNotFoundException') {
    return c.json({ message: 'Cognito local resources are not ready.' }, 503)
  }

  if (error.status >= 500) {
    return c.json({ message: 'Cognito local service is unavailable.' }, 502)
  }

  return c.json({ message: error.message }, 400)
}

class FlociCognitoClient {
  private readonly endpoint = trimTrailingSlash(
    Bun.env.COGNITO_ENDPOINT ?? Bun.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
  )

  private readonly userPoolId = Bun.env.COGNITO_USER_POOL_ID
  private readonly userPoolName = Bun.env.COGNITO_USER_POOL_NAME ?? 'mukuroji-local'
  private readonly clientId = Bun.env.COGNITO_CLIENT_ID
  private readonly clientName = Bun.env.COGNITO_USER_POOL_CLIENT_NAME ?? 'mukuroji-web-local'
  private resolvedUserPoolId: string | undefined
  private resolvedClientId: string | undefined

  async initiatePasswordAuth(email: string, password: string) {
    const clientId = await this.resolveClientId()

    return this.request<InitiateAuthResponse>('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: clientId,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
      },
    })
  }

  async getUser(accessToken: string) {
    return this.request<GetUserResponse>('GetUser', {
      AccessToken: accessToken,
    })
  }

  private async resolveClientId() {
    if (this.resolvedClientId) {
      return this.resolvedClientId
    }

    if (this.clientId) {
      this.resolvedClientId = this.clientId
      return this.resolvedClientId
    }

    const userPoolId = await this.resolveUserPoolId()
    const response = await this.request<ListUserPoolClientsResponse>('ListUserPoolClients', {
      UserPoolId: userPoolId,
      MaxResults: 60,
    })

    const client = response.UserPoolClients?.find(
      (candidate) => candidate.ClientName === this.clientName,
    )

    if (!client?.ClientId) {
      throw new CognitoServiceError(
        404,
        'ClientNotFoundException',
        `Cognito user pool client "${this.clientName}" was not found.`,
      )
    }

    this.resolvedClientId = client.ClientId
    return this.resolvedClientId
  }

  private async resolveUserPoolId() {
    if (this.resolvedUserPoolId) {
      return this.resolvedUserPoolId
    }

    if (this.userPoolId) {
      this.resolvedUserPoolId = this.userPoolId
      return this.resolvedUserPoolId
    }

    const response = await this.request<ListUserPoolsResponse>('ListUserPools', {
      MaxResults: 60,
    })

    const userPool = response.UserPools?.find(
      (candidate) => candidate.Name === this.userPoolName,
    )

    if (!userPool?.Id) {
      throw new CognitoServiceError(
        404,
        'ResourceNotFoundException',
        `Cognito user pool "${this.userPoolName}" was not found.`,
      )
    }

    this.resolvedUserPoolId = userPool.Id
    return this.resolvedUserPoolId
  }

  private async request<T>(action: string, payload: Record<string, unknown>) {
    let response: Response

    try {
      response = await fetch(`${this.endpoint}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`,
        },
        body: JSON.stringify(payload),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown network error.'
      throw new CognitoServiceError(503, 'CognitoUnavailable', message)
    }

    const data = await parseJsonResponse<T | CognitoErrorPayload>(response)

    if (!response.ok) {
      const errorPayload = data as CognitoErrorPayload
      throw new CognitoServiceError(
        response.status,
        normalizeCognitoErrorCode(errorPayload.__type) ?? 'CognitoError',
        errorPayload.message ?? errorPayload.Message ?? response.statusText,
      )
    }

    return data as T
  }
}

class CognitoServiceError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text()

  if (!text) {
    return {} as T
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw new CognitoServiceError(
      response.status,
      'InvalidCognitoResponse',
      'Cognito returned invalid JSON.',
    )
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}

function normalizeCognitoErrorCode(value: string | undefined) {
  return value?.split('#').pop()
}

cognito = new FlociCognitoClient()

export default {
  port: Number(Bun.env.PORT ?? 3000),
  fetch: app.fetch,
}
