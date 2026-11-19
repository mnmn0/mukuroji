import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { customerDetailFixture, customerFixture } from '../src/customers/fixtures'
import { CustomerDirectoryView, type CustomerDirectoryViewProps } from '../src/customers/ui/CustomerDirectoryView'
import type { CustomerEditingProps } from '../src/customers/ui/CustomerEditors'
import { createTranslator } from '../src/shared/i18n/i18n'

const noop = () => undefined
const resolved = async () => true

const baseProps: CustomerDirectoryViewProps = {
  canManageCustomerViews: false,
  canViewSensitiveData: true,
  customers: [customerFixture],
  detail: customerDetailFixture,
  filters: {},
  hasMoreCustomers: false,
  isLoading: false,
  isLoadingMoreCustomers: false,
  isSavingView: false,
  locale: 'en-US',
  onApplySavedView: noop,
  onFiltersChange: noop,
  onGroupByChange: noop,
  onLoadMoreCustomers: noop,
  onOpenProject: noop,
  onOpenWorkItem: noop,
  onRetry: noop,
  onSaveView: noop,
  onSearchChange: noop,
  onSelectCustomer: noop,
  savedViews: [],
  search: '',
  t: createTranslator('en'),
}

const editing: CustomerEditingProps = {
  isSaving: false,
  projects: [{ id: 'project-1', name: 'Quarterly review' }],
  onCreateCustomer: resolved,
  onUpdateCustomer: resolved,
  onCreateContact: resolved,
  onUpdateContact: resolved,
  onDeleteContact: resolved,
  onCreateRequest: resolved,
  onUpdateRequest: resolved,
  onLinkWorkItem: resolved,
  onUnlinkWorkItem: resolved,
  onLinkProject: resolved,
  onUnlinkProject: resolved,
}

describe('Customer directory editing controls', () => {
  test('stay hidden from members who may not change Customers', () => {
    const markup = renderToStaticMarkup(<CustomerDirectoryView {...baseProps} />)
    expect(markup).not.toContain('Add customer')
    expect(markup).not.toContain('Edit Acme Industries')
    expect(markup).not.toContain('Add contact')
    expect(markup).not.toContain('Record a request')
    expect(markup).not.toContain('Link work item')
  })

  test('appear for members who may change Customers, with linked Projects named', () => {
    const markup = renderToStaticMarkup(<CustomerDirectoryView {...baseProps} editing={editing} />)
    expect(markup).toContain('Add customer')
    expect(markup).toContain('aria-label="Edit Acme Industries"')
    expect(markup).toContain('aria-label="Delete Mina Example"')
    expect(markup).toContain('Add contact')
    expect(markup).toContain('Record a request')
    expect(markup).toContain('Link work item')
    expect(markup).toContain('Project Quarterly review')
    expect(markup).toContain('Work item work-item-1')
  })

  test('announce the latest failed change', () => {
    const markup = renderToStaticMarkup(
      <CustomerDirectoryView {...baseProps} editing={{ ...editing, errorMessage: 'Someone else changed this first.' }} />,
    )
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Someone else changed this first.')
  })
})
