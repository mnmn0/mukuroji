import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { AuthSession } from '../src/auth/session'
import { SecurityRecoveryPage } from '../src/pages/auth/SecurityRecoveryPage'

const recoverySession = {
  accessToken: 'recovery-access-token',
  expiresAt: Date.now() + 60 * 60_000,
  remember: false,
  tokenType: 'Bearer',
} satisfies AuthSession

describe('SecurityRecoveryPage', () => {
  test('renders an audited reason and keyboard-focusable duration choices', () => {
    const router = createMemoryRouter(
      [
        {
          element: (
            <SecurityRecoveryPage
              getSession={() => recoverySession}
              initialLocale="en"
              onActivated={() => undefined}
            />
          ),
          path: '/security/recovery',
        },
      ],
      {
        initialEntries: ['/security/recovery'],
      },
    )
    const html = renderToStaticMarkup(<RouterProvider router={router} />)

    expect(html).toContain('name="reason"')
    expect(html.match(/name="durationMinutes"/g)).toHaveLength(3)
    expect(html).toContain('focus-within:outline')
    expect(html).toContain('focus-within:ring-3')
    expect(html).toContain('Start recovery access')
    expect(html).not.toContain('recovery-access-token')
  })
})
