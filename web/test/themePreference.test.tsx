import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import {
  applyThemePreference,
  getInitialThemePreference,
  isThemePreference,
  setThemePreference,
} from '../src/shared/lib/preferences/theme'
import { createTranslator } from '../src/shared/i18n/i18n'
import { WorkspaceSettingsView } from '../src/workspace/ui/WorkspaceSettingsView'

const originalWindow = globalThis.window
const originalDocument = globalThis.document

/** Minimal browser globals used by the theme preference module. */
function installBrowserStubs(storage: Map<string, string>, failStorage = false) {
  const root = { dataset: {} as Record<string, string> }
  Object.assign(globalThis, {
    window: {
      localStorage: {
        getItem(key: string) {
          if (failStorage) throw new Error('blocked')
          return storage.get(key) ?? null
        },
        setItem(key: string, value: string) {
          if (failStorage) throw new Error('blocked')
          storage.set(key, value)
        },
      },
    },
    document: { documentElement: root },
  })
  return root
}

beforeEach(() => {
  installBrowserStubs(new Map())
})

afterEach(() => {
  Object.assign(globalThis, { window: originalWindow, document: originalDocument })
})

describe('theme preference', () => {
  test('accepts only light, dark, and system', () => {
    expect(isThemePreference('dark')).toBe(true)
    expect(isThemePreference('system')).toBe(true)
    expect(isThemePreference('sepia')).toBe(false)
    expect(isThemePreference(null)).toBe(false)
  })

  test('defaults to light and restores a saved theme', () => {
    expect(getInitialThemePreference()).toBe('light')
    installBrowserStubs(new Map([['mukuroji.theme', 'dark']]))
    expect(getInitialThemePreference()).toBe('dark')
    installBrowserStubs(new Map([['mukuroji.theme', 'neon']]))
    expect(getInitialThemePreference()).toBe('light')
  })

  test('saves and applies the theme to the html root', () => {
    const storage = new Map<string, string>()
    const root = installBrowserStubs(storage)

    setThemePreference('system')

    expect(storage.get('mukuroji.theme')).toBe('system')
    expect(root.dataset.theme).toBe('system')
  })

  test('still applies the theme when storage is blocked', () => {
    const root = installBrowserStubs(new Map(), true)

    expect(getInitialThemePreference()).toBe('light')
    setThemePreference('dark')
    expect(root.dataset.theme).toBe('dark')

    applyThemePreference('light')
    expect(root.dataset.theme).toBe('light')
  })
})

describe('Workspace settings theme control', () => {
  test('renders the three themes with the selected one pressed', () => {
    const t = createTranslator('en')
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <WorkspaceSettingsView
          fontSizePreference="standard"
          locale="en"
          onFontSizePreferenceChange={() => undefined}
          onThemePreferenceChange={() => undefined}
          t={t}
          themePreference="dark"
        userLabel="demo@example.com"
        />
      </MemoryRouter>,
    )

    expect(html).toContain('data-testid="theme-preference-control"')
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="theme-preference-dark"/)
    expect(html).toMatch(/aria-pressed="false"[^>]*data-testid="theme-preference-light"/)
    expect(html).toContain('System')
  })
})

describe('theme bootstrap script', () => {
  const source = readFileSync(new URL('../public/theme-bootstrap.js', import.meta.url), 'utf8')
  const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

  test('is loaded as a blocking same-origin script in the document head', () => {
    const head = indexHtml.slice(0, indexHtml.indexOf('</head>'))
    expect(head).toContain('<script src="/theme-bootstrap.js"></script>')
  })

  test('applies the same saved preference as the application before it loads', () => {
    for (const preference of ['light', 'dark', 'system'] as const) {
      const storage = new Map([['mukuroji.theme', preference]])
      const root = installBrowserStubs(storage)
      new Function(source)()
      expect(root.dataset.theme).toBe(preference)
      expect(getInitialThemePreference()).toBe(preference)
    }
  })

  test('leaves the root untouched for unknown values and blocked storage', () => {
    const root = installBrowserStubs(new Map([['mukuroji.theme', 'sepia']]))
    new Function(source)()
    expect(root.dataset.theme).toBeUndefined()

    const blockedRoot = installBrowserStubs(new Map(), true)
    expect(() => new Function(source)()).not.toThrow()
    expect(blockedRoot.dataset.theme).toBeUndefined()
  })
})
