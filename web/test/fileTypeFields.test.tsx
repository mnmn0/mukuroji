import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTranslator } from '../src/shared/i18n/i18n'
import { FileTypeFields } from '../src/workspace/ui/FileTypeFields'

const ja = createTranslator('ja')

test('lists catalog types with their state and never offers a dangerous type', () => {
  const markup = renderToStaticMarkup(
    <FileTypeFields
      disabled={false}
      onChange={() => undefined}
      settings={{ allowed: ['rar'], blocked: ['xlsm'] }}
      t={ja}
    />,
  )
  expect(markup).toContain('.md .markdown')
  expect(markup).toContain('.drawio')
  expect(markup).toMatch(/data-testid="tenant-file-type-rar" type="checkbox" checked=""/u)
  expect(markup).not.toMatch(/data-testid="tenant-file-type-xlsm" type="checkbox" checked=""/u)
  for (const dangerous of ['exe', 'svg', 'html', 'bat']) {
    expect(markup).not.toContain(`tenant-file-type-${dangerous}`)
  }
  expect(markup).toContain(ja('workspace.tenantAdministration.fileTypes.neverAllowed'))
})
