import { describe, expect, test } from 'bun:test'
import {
  consumePendingEnterpriseSsoLogin,
  isSafeEnterpriseSsoAuthorizationUrl,
  savePendingEnterpriseSsoLogin,
  scrubEnterpriseSsoCallbackUrl,
} from '../src/auth/enterpriseSso'

describe('enterprise SSO browser helpers', () => {
  test('allows HTTPS authorization endpoints and rejects unsafe schemes', () => {
    expect(
      isSafeEnterpriseSsoAuthorizationUrl(
        'https://tenant.auth.example.com/oauth2/authorize',
      ),
    ).toBe(true)
    expect(
      isSafeEnterpriseSsoAuthorizationUrl(
        'http://localhost:5173/mock-sso',
      ),
    ).toBe(true)
    expect(
      isSafeEnterpriseSsoAuthorizationUrl(
        'http://attacker.example/oauth2/authorize',
      ),
    ).toBe(false)
    expect(
      isSafeEnterpriseSsoAuthorizationUrl('javascript:alert(1)'),
    ).toBe(false)
  })

  test('consumes matching unexpired state once and rejects expired state', () => {
    const originalWindow = Object.getOwnPropertyDescriptor(
      globalThis,
      'window',
    )
    const storedValues = new Map<string, string>()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        sessionStorage: {
          getItem: (key: string) => storedValues.get(key) ?? null,
          removeItem: (key: string) => storedValues.delete(key),
          setItem: (key: string, value: string) =>
            storedValues.set(key, value),
        },
      },
    })

    try {
      const currentTime = 1_000_000
      const pending = {
        codeVerifier: 'a'.repeat(43),
        expiresAt: currentTime + 60_000,
        remember: true,
        returnTo: '/dashboard',
        state: 'signed-state',
      }
      savePendingEnterpriseSsoLogin(pending)

      expect(
        consumePendingEnterpriseSsoLogin(
          'unsolicited-state',
          currentTime,
        ),
      ).toBeUndefined()
      expect(
        consumePendingEnterpriseSsoLogin('signed-state', currentTime),
      ).toEqual(pending)
      expect(
        consumePendingEnterpriseSsoLogin('signed-state', currentTime),
      ).toBeUndefined()

      savePendingEnterpriseSsoLogin({
        ...pending,
        expiresAt: currentTime - 1,
      })
      expect(
        consumePendingEnterpriseSsoLogin('signed-state', currentTime),
      ).toBeUndefined()
    } finally {
      if (originalWindow) {
        Object.defineProperty(globalThis, 'window', originalWindow)
      } else {
        Reflect.deleteProperty(globalThis, 'window')
      }
    }
  })

  test('scrubs authorization code and state from the callback history entry', () => {
    const originalWindow = Object.getOwnPropertyDescriptor(
      globalThis,
      'window',
    )
    const replacements: Array<[unknown, string, string]> = []
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        history: {
          replaceState: (
            state: unknown,
            title: string,
            url: string,
          ) => replacements.push([state, title, url]),
          state: { navigation: 'callback' },
        },
        location: {
          pathname: '/auth/sso/callback',
          search: '?code=secret-code&state=signed-state',
        },
      },
    })

    try {
      scrubEnterpriseSsoCallbackUrl()

      expect(replacements).toEqual([
        [
          { navigation: 'callback' },
          '',
          '/auth/sso/callback',
        ],
      ])
    } finally {
      if (originalWindow) {
        Object.defineProperty(globalThis, 'window', originalWindow)
      } else {
        Reflect.deleteProperty(globalThis, 'window')
      }
    }
  })

  test('scrubs callback secrets even when session storage is blocked', () => {
    const originalWindow = Object.getOwnPropertyDescriptor(
      globalThis,
      'window',
    )
    const replacements: Array<[unknown, string, string]> = []
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        history: {
          replaceState: (
            state: unknown,
            title: string,
            url: string,
          ) => replacements.push([state, title, url]),
          state: null,
        },
        location: {
          pathname: '/auth/sso/callback',
        },
        sessionStorage: {
          getItem: () => {
            throw new Error('Storage blocked')
          },
        },
      },
    })

    try {
      scrubEnterpriseSsoCallbackUrl()

      expect(
        consumePendingEnterpriseSsoLogin('signed-state'),
      ).toBeUndefined()
      expect(replacements).toEqual([
        [null, '', '/auth/sso/callback'],
      ])
    } finally {
      if (originalWindow) {
        Object.defineProperty(globalThis, 'window', originalWindow)
      } else {
        Reflect.deleteProperty(globalThis, 'window')
      }
    }
  })
})
