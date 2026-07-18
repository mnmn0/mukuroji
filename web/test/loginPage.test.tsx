import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { LoginPage } from '../src/pages/LoginPage'

describe('LoginPage', () => {
  test('collects email before rendering a password field', () => {
    const html = renderLoginPage(<LoginPage initialLocale="en" />)

    expect(html).toContain('name="email"')
    expect(html).toContain('>Continue</button>')
    expect(html).not.toContain('name="password"')
  })

  test('renders password only after non-SSO discovery', () => {
    const html = renderLoginPage(
      <LoginPage
        initialEmail="member@example.com"
        initialLoginStep="password"
        initialLocale="en"
      />,
    )

    expect(html).toContain('member@example.com')
    expect(html).toContain('autoComplete="username"')
    expect(html).toContain('readOnly=""')
    expect(html).toContain('name="password"')
    expect(html).toContain('autoComplete="current-password"')
  })

  test('renders a numeric one-time-code field for MFA challenge continuation', () => {
    const html = renderLoginPage(
      <LoginPage
        initialChallenge={{
          challenge: 'SMS_OTP',
          deliveryDestination: '+81 ******1234',
          deliveryMedium: 'SMS',
          email: 'recovery@example.com',
          session: 'opaque-mfa-session',
        }}
        initialChallengeFailed
        initialLocale="en"
      />,
    )

    expect(html).toContain('autoComplete="one-time-code"')
    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('mfa-code-error')
    expect(html).toContain('inputMode="numeric"')
    expect(html).toContain('+81 ******1234')
    expect(html).not.toContain('opaque-mfa-session')
  })
})

function renderLoginPage(element: ReactNode) {
  const router = createMemoryRouter(
    [
      {
        element,
        path: '/login',
      },
    ],
    {
      initialEntries: ['/login'],
    },
  )

  return renderToStaticMarkup(<RouterProvider router={router} />)
}
