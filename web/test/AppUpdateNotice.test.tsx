import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTranslator, type Locale } from '../src/shared/i18n/i18n'
import { AppUpdateNotice } from '../src/shared/ui/AppUpdateNotice'

describe('AppUpdateNotice', () => {
  test('announces the update politely with touch-sized actions in both locales', () => {
    const locales: Locale[] = ['ja', 'en']

    for (const locale of locales) {
      const t = createTranslator(locale)
      const markup = renderToStaticMarkup(
        <AppUpdateNotice
          message={t('app.update.available')}
          reloadLabel={t('app.update.reload')}
          dismissLabel={t('app.update.dismiss')}
          onReload={() => undefined}
          onDismiss={() => undefined}
        />,
      )

      expect(markup).toContain('role="status"')
      expect(markup).toContain(t('app.update.available'))
      expect(markup).toContain(`>${t('app.update.reload')}</button>`)
      expect(markup).toContain(`>${t('app.update.dismiss')}</button>`)
      expect(markup.match(/min-h-11/g)).toHaveLength(2)
      expect(markup).toContain('safe-area-inset-bottom')
    }
  })
})
