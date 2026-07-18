/**
 * Enterprise SSO redirect 中だけ sessionStorage に保持する request state です。
 */
export type PendingEnterpriseSsoLogin = {
  /** Server が発行した一回限り state です。 */
  state: string
  /** Authorization code exchange に必要な PKCE verifier です。 */
  codeVerifier: string
  /** Login 完了後に session を永続化するかどうかです。 */
  remember: boolean
  /** Login 完了後に戻す検証済み app path です。 */
  returnTo: string
  /** Pending request が失効する Unix time milliseconds です。 */
  expiresAt: number
}

const pendingEnterpriseSsoStorageKey = 'mukuroji.auth.sso.pending'
const pendingEnterpriseSsoLifetimeMs = 10 * 60 * 1_000

/**
 * Redirect 後の code exchange に必要な pending state を保存します。
 */
export function savePendingEnterpriseSsoLogin(
  pendingLogin: PendingEnterpriseSsoLogin,
) {
  window.sessionStorage.setItem(
    pendingEnterpriseSsoStorageKey,
    JSON.stringify(pendingLogin),
  )
}

/**
 * Callback state と一致する未使用の pending login を一回だけ取り出します。
 */
export function consumePendingEnterpriseSsoLogin(
  expectedState: string,
  currentTime = Date.now(),
): PendingEnterpriseSsoLogin | undefined {
  let serialized: string | null
  try {
    serialized = window.sessionStorage.getItem(
      pendingEnterpriseSsoStorageKey,
    )
  } catch {
    return undefined
  }

  if (!serialized) {
    return undefined
  }

  try {
    const parsed = JSON.parse(serialized) as Partial<PendingEnterpriseSsoLogin>
    if (
      typeof parsed.state !== 'string' ||
      typeof parsed.codeVerifier !== 'string' ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(parsed.codeVerifier) ||
      typeof parsed.remember !== 'boolean' ||
      typeof parsed.returnTo !== 'string' ||
      typeof parsed.expiresAt !== 'number' ||
      !Number.isFinite(parsed.expiresAt) ||
      currentTime > parsed.expiresAt ||
      parsed.expiresAt - currentTime > pendingEnterpriseSsoLifetimeMs
    ) {
      try {
        window.sessionStorage.removeItem(
          pendingEnterpriseSsoStorageKey,
        )
      } catch {
        // Storage が利用できなくても callback は fail closed にします。
      }
      return undefined
    }

    if (parsed.state !== expectedState) {
      return undefined
    }

    try {
      window.sessionStorage.removeItem(pendingEnterpriseSsoStorageKey)
    } catch {
      return undefined
    }

    return parsed as PendingEnterpriseSsoLogin
  } catch {
    try {
      window.sessionStorage.removeItem(pendingEnterpriseSsoStorageKey)
    } catch {
      // Storage が利用できなくても callback は fail closed にします。
    }
    return undefined
  }
}

/**
 * Authorization code と state を browser address bar/history entry から直ちに除去します。
 */
export function scrubEnterpriseSsoCallbackUrl() {
  if (
    typeof window === 'undefined' ||
    window.location.pathname !== '/auth/sso/callback'
  ) {
    return
  }

  window.history.replaceState(
    window.history.state,
    '',
    '/auth/sso/callback',
  )
}

/**
 * Server が返した authorization URL が安全な browser 遷移先か検証します。
 */
export function isSafeEnterpriseSsoAuthorizationUrl(value: string) {
  try {
    const url = new URL(value)
    if (url.username || url.password) {
      return false
    }

    if (url.protocol === 'https:') {
      return true
    }

    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]')
    )
  } catch {
    return false
  }
}
