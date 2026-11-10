import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import {
  applyThemePreference,
  getInitialThemePreference,
  isThemePreference,
  setThemePreference,
  themePreferenceOptions,
} from '../src/shared/lib/preferences/theme'
import { createTranslator } from '../src/shared/i18n/i18n'
import { WorkspaceSettingsView } from '../src/workspace/ui/WorkspaceSettingsView'

const originalWindow = globalThis.window
const originalDocument = globalThis.document

/** Minimal `theme-color` meta element with the attributes the theme scripts read and write. */
class ThemeColorMetaStub {
  /** Attribute values keyed by attribute name. */
  readonly attributes: Map<string, string>

  /**
   * Creates a meta stub with a media query and its initial color.
   *
   * @param media - The `media` attribute value.
   * @param content - The initial `content` attribute value.
   */
  constructor(media: string, content: string) {
    this.attributes = new Map([['content', content], ['media', media]])
  }

  /**
   * Reads an attribute.
   *
   * @param name - Attribute name.
   * @returns The attribute value, or `null` when it is missing.
   */
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null
  }

  /**
   * Writes an attribute.
   *
   * @param name - Attribute name.
   * @param value - New attribute value.
   */
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }
}

/** Light and dark `theme-color` metas as declared by `index.html` and `offline.html`. */
let themeColorMetas: ThemeColorMetaStub[] = []

/**
 * Reads the current `content` of the light and dark `theme-color` metas.
 *
 * @returns The light and dark meta colors, in document order.
 */
function themeColors() {
  return themeColorMetas.map((meta) => meta.getAttribute('content'))
}

/** Minimal browser globals used by the theme preference module. */
function installBrowserStubs(storage: Map<string, string>, failStorage = false) {
  const root = { dataset: {} as Record<string, string> }
  themeColorMetas = [
    new ThemeColorMetaStub('(prefers-color-scheme: light)', '#f7f9f8'),
    new ThemeColorMetaStub('(prefers-color-scheme: dark)', '#0e1412'),
  ]
  Object.assign(globalThis, {
    window: {
      addEventListener() {},
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
    document: {
      addEventListener() {},
      documentElement: root,
      querySelectorAll(selector: string) {
        return selector === 'meta[name="theme-color"]' ? themeColorMetas : []
      },
    },
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

  test('points the theme-color metas at the applied theme canvas', () => {
    applyThemePreference('dark')
    expect(themeColors()).toEqual(['#0e1412', '#0e1412'])

    applyThemePreference('light')
    expect(themeColors()).toEqual(['#f7f9f8', '#f7f9f8'])

    setThemePreference('system')
    expect(themeColors()).toEqual(['#f7f9f8', '#0e1412'])
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

  test('declares a theme-color meta for each color scheme before the bootstrap runs', () => {
    const head = indexHtml.slice(0, indexHtml.indexOf('</head>'))
    const lightMeta = '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f7f9f8" />'
    const darkMeta = '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0e1412" />'
    const bootstrap = head.indexOf('<script src="/theme-bootstrap.js"></script>')
    expect(head.indexOf(lightMeta)).toBeGreaterThan(-1)
    expect(head.indexOf(lightMeta)).toBeLessThan(bootstrap)
    expect(head.indexOf(darkMeta)).toBeGreaterThan(-1)
    expect(head.indexOf(darkMeta)).toBeLessThan(bootstrap)
  })

  test('applies the same saved preference as the application before it loads', () => {
    for (const preference of ['light', 'dark', 'system'] as const) {
      const storage = new Map([['mukuroji.theme', preference]])
      const root = installBrowserStubs(storage)
      new Function(source)()
      expect(root.dataset.theme).toBe(preference)
      const bootstrapColors = themeColors()
      expect(getInitialThemePreference()).toBe(preference)
      applyThemePreference(preference)
      expect(bootstrapColors).toEqual(themeColors())
    }
  })

  test('keeps the theme-color light for the default theme', () => {
    installBrowserStubs(new Map())
    new Function(source)()
    expect(themeColors()).toEqual(['#f7f9f8', '#f7f9f8'])

    installBrowserStubs(new Map(), true)
    new Function(source)()
    expect(themeColors()).toEqual(['#f7f9f8', '#f7f9f8'])
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

describe('offline page theme', () => {
  const offlineHtml = readFileSync(new URL('../public/offline.html', import.meta.url), 'utf8')
  const offlineCss = readFileSync(new URL('../public/offline.css', import.meta.url), 'utf8')
  const offlineScript = readFileSync(new URL('../public/offline.js', import.meta.url), 'utf8')

  test('loads its precached script in the head so the theme applies before paint', () => {
    const head = offlineHtml.slice(0, offlineHtml.indexOf('</head>'))
    expect(head).toContain('<script src="/offline.js"></script>')
    expect(head).toContain('media="(prefers-color-scheme: dark)" content="#0e1412"')
    expect(offlineHtml).not.toMatch(/<script>/u)
  })

  test('applies the saved preference and theme-color like the application', () => {
    for (const preference of themePreferenceOptions) {
      const root = installBrowserStubs(new Map([['mukuroji.theme', preference]]))
      new Function(offlineScript)()
      expect(root.dataset.theme).toBe(preference)
      const offlineColors = themeColors()
      applyThemePreference(preference)
      expect(offlineColors).toEqual(themeColors())
    }

    const blockedRoot = installBrowserStubs(new Map(), true)
    expect(() => new Function(offlineScript)()).not.toThrow()
    expect(blockedRoot.dataset.theme).toBeUndefined()
    expect(themeColors()).toEqual(['#f7f9f8', '#f7f9f8'])
  })

  test('defines a dark palette for explicit dark and a dark system preference', () => {
    expect(offlineCss).toMatch(/:root\[data-theme="dark"\] \{[^}]*color-scheme: dark;[^}]*--offline-canvas: #0e1412;/u)
    expect(offlineCss).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\s*:root\[data-theme="system"\] \{[^}]*--offline-canvas: #0e1412;/u,
    )
    expect(offlineCss).toContain('background: var(--offline-canvas)')
    expect(offlineCss).not.toMatch(/body \{[^}]*background: #/u)
  })
})

describe('theme stylesheet tokens', () => {
  const stylesheet = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

  test('keeps paper colors fixed so light content surfaces stay light in dark mode', () => {
    for (const token of ['paper', 'paper-tint', 'paper-ink', 'paper-muted', 'paper-accent']) {
      const declarations = stylesheet.match(new RegExp(`--color-${token}:`, 'gu')) ?? []
      expect(declarations).toHaveLength(1)
    }
    expect(stylesheet).toContain('--color-paper: #ffffff;')
    expect(stylesheet).toContain('--color-paper-ink: #17201d;')
  })

  test('defines Gantt link colors for the light, dark, and dark system themes', () => {
    for (const variable of ['gantt-link', 'gantt-link-critical', 'gantt-link-conflict']) {
      const declarations = stylesheet.match(new RegExp(`--workbench-${variable}:`, 'gu')) ?? []
      expect(declarations).toHaveLength(3)
    }
    const darkBlock = stylesheet.slice(stylesheet.indexOf(":root[data-theme='dark'] {"))
    expect(darkBlock).toMatch(/--workbench-gantt-link: #a3b0c2;/u)
  })
})
