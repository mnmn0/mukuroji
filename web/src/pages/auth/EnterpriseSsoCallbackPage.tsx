import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import {
  exchangeEnterpriseSso,
  ApiError,
} from '../../auth/api'
import {
  consumePendingEnterpriseSsoLogin,
  scrubEnterpriseSsoCallbackUrl,
} from '../../auth/enterpriseSso'
import {
  createMutationFingerprint,
  createMutationRequestRunner,
} from '../../shared/api/mutationHeaders'
import { saveAuthSession } from '../../auth/session'
import { BrandMark } from '../../shared/ui/BrandMark'
import {
  createTranslator,
  getInitialLocale,
} from '../../shared/i18n/i18n'
import { resolveSafeLoginReturnPath } from './loginReturnPath'

/**
 * Enterprise SSO authorization callback を検証して login session を確立します。
 */
export function EnterpriseSsoCallbackPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [failed, setFailed] = useState(false)
  const [retryReturnTo, setRetryReturnTo] = useState('/dashboard')
  const startedRef = useRef(false)
  const [mutationRequestRunner] = useState(() =>
    createMutationRequestRunner(),
  )
  const t = useMemo(
    () => createTranslator(getInitialLocale()),
    [],
  )

  useEffect(() => {
    if (startedRef.current) {
      return
    }
    startedRef.current = true

    const completeLogin = async () => {
      const code = searchParams.get('code') ?? ''
      const state = searchParams.get('state') ?? ''
      const authorizationError = searchParams.get('error')

      scrubEnterpriseSsoCallbackUrl()
      const pendingLogin = state
        ? consumePendingEnterpriseSsoLogin(state)
        : undefined

      if (pendingLogin) {
        setRetryReturnTo(
          resolveSafeLoginReturnPath(pendingLogin.returnTo),
        )
      }

      if (authorizationError || !code || !state || !pendingLogin) {
        throw new Error('Enterprise SSO callback could not be verified.')
      }

      const fingerprint = await createMutationFingerprint(code, state)
      const result = await mutationRequestRunner.run(
        'auth:sso:exchange',
        fingerprint,
        (context) =>
          exchangeEnterpriseSso(
            {
              code,
              codeVerifier: pendingLogin.codeVerifier,
              remember: pendingLogin.remember,
              state,
            },
            context,
          ),
        (error) => !(error instanceof ApiError),
      )

      saveAuthSession(result.session)
      navigate(resolveSafeLoginReturnPath(result.returnTo), {
        replace: true,
      })
    }

    void completeLogin().catch(() => setFailed(true))
  }, [mutationRequestRunner, navigate, searchParams])

  return (
    <main className="workbench-shell grid min-h-svh place-items-center bg-[var(--workbench-page)] p-5">
      <section
        aria-live="polite"
        className="workbench-panel grid w-full max-w-[520px] justify-items-center gap-5 p-8 text-center"
      >
        <div className="inline-flex items-center gap-3 text-2xl font-semibold text-[var(--workbench-text)]">
          <BrandMark />
          <span>mukuroji</span>
        </div>
        <div>
          <h1 className="text-xl font-semibold text-[var(--workbench-text)]">
            {t(
              failed
                ? 'login.ssoCallback.errorTitle'
                : 'login.ssoCallback.title',
            )}
          </h1>
          <p
            className={`mt-3 text-sm font-medium leading-6 ${
              failed
                ? 'text-red-700'
                : 'text-[var(--workbench-muted)]'
            }`}
            role={failed ? 'alert' : 'status'}
          >
            {t(
              failed
                ? 'login.ssoCallback.errorDescription'
                : 'login.ssoCallback.description',
            )}
          </p>
        </div>
        {failed ? (
          <Link
            className="workbench-button-primary inline-flex min-h-10 items-center px-4 no-underline"
            replace
            to={`/login?returnTo=${encodeURIComponent(retryReturnTo)}`}
          >
            {t('login.ssoCallback.retry')}
          </Link>
        ) : (
          <span
            aria-hidden="true"
            className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-[var(--workbench-primary)]"
          />
        )}
      </section>
    </main>
  )
}
