import { describe, expect, test } from 'bun:test'
import { isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { appRoutes } from '../src/app/router'
import { RouteErrorPage } from '../src/pages/public/RouteErrorPage'

describe('RouteErrorPage', () => {
  test('explains the failure and offers a reload', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <RouteErrorPage initialLocale="en" onReload={() => undefined} />
      </MemoryRouter>,
    )

    expect(markup).toContain('This page could not be loaded')
    expect(markup).toContain('role="alert"')
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*>Reload<\/button>/u)
  })

  test('handles errors from every route, including pages that fail to load', () => {
    expect(appRoutes).toHaveLength(1)
    const root = appRoutes[0]
    expect(isValidElement(root?.errorElement) && root.errorElement.type).toBe(RouteErrorPage)
    expect(root?.hydrateFallbackElement).toBeDefined()
  })
})
