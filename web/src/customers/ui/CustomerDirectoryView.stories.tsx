import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { customerDetailFixture, customerFixture } from '../fixtures'
import { CustomerDirectoryView } from './CustomerDirectoryView'
import type { CustomerEditingProps } from './CustomerEditors'

const customer = customerFixture
const detail = customerDetailFixture

const meta = {
  title: 'Customers/CustomerDirectoryView',
  component: CustomerDirectoryView,
  parameters: { layout: 'fullscreen' },
  decorators: [(Story) => <div className="workbench-shell min-h-screen"><Story /></div>],
  args: {
    canManageCustomerViews: true,
    canViewSensitiveData: true,
    customers: [customer],
    detail,
    errorMessage: undefined,
    filters: {},
    groupBy: undefined,
    hasMoreCustomers: false,
    isLoading: false,
    isLoadingMoreCustomers: false,
    isSavingView: false,
    locale: 'en-US',
    onApplySavedView: () => undefined,
    onFiltersChange: () => undefined,
    onGroupByChange: () => undefined,
    onLoadMoreCustomers: () => undefined,
    onOpenProject: () => undefined,
    onOpenWorkItem: () => undefined,
    onRetry: () => undefined,
    onSaveView: () => undefined,
    onSearchChange: () => undefined,
    onSelectCustomer: () => undefined,
    search: '',
    t: createTranslator('en'),
    savedViews: [],
  },
} satisfies Meta<typeof CustomerDirectoryView>

/** Storybook metadata for the Customer directory view. */
export default meta

/** Story type for the Customer directory view. */
type Story = StoryObj<typeof meta>

/** Customer directory with contacts, source Requests, and a linked Work Item. */
export const Default: Story = {}

/** Phone customer results precede secondary filters and saved-view controls. */
export const MobileFilters: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    if (!window.matchMedia('(max-width: 760px)').matches) return
    const canvas = within(canvasElement)
    const disclosure = canvas.getByRole('button', { name: /Filters and sorting/ })
    await expect(canvas.queryByRole('combobox')).not.toBeInTheDocument()
    await userEvent.click(disclosure)
    await expect(canvas.getByRole('combobox', { name: 'Tier filter' })).toBeVisible()
    await userEvent.click(disclosure)
    await expect(canvas.getByRole('heading', { name: 'Customers' })).toBeVisible()
  },
}

/** Empty state after a search returned no matching Customers. */
export const Empty: Story = {
  args: { customers: [], detail: undefined, onOpenProject: () => undefined, search: 'missing' },
}

/** Renders the directory for a member without sensitive-data access. */
export const Restricted: Story = {
  args: {
    canManageCustomerViews: false,
    canViewSensitiveData: false,
    search: '',
  },
}

/** Editing operations that resolve immediately so the forms can be exercised in Storybook. */
const storyEditing: CustomerEditingProps = {
  isSaving: false,
  projects: [{ id: 'project-1', name: 'Quarterly review' }, { id: 'project-2', name: 'Data export' }],
  onCreateCustomer: async () => true,
  onUpdateCustomer: async () => true,
  onCreateContact: async () => true,
  onUpdateContact: async () => true,
  onDeleteContact: async () => true,
  onCreateRequest: async () => true,
  onUpdateRequest: async () => true,
  onLinkWorkItem: async () => true,
  onUnlinkWorkItem: async () => true,
  onLinkProject: async () => true,
  onUnlinkProject: async () => true,
}

/** A member who may change Customers sees add, edit, delete, and link controls. */
export const Editable: Story = {
  args: { editing: storyEditing },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Edit Acme Industries' }))
    const form = canvas.getByRole('form', { name: 'Edit customer' })
    await expect(within(form).getByRole('textbox', { name: 'Name' })).toHaveValue('Acme Industries')
    await userEvent.clear(within(form).getByRole('textbox', { name: 'Name' }))
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await expect(within(form).getByRole('alert')).toHaveTextContent('Enter a name')
    await userEvent.click(within(form).getByRole('button', { name: 'Cancel' }))
    await expect(canvas.getByRole('button', { name: 'Unlink Project Quarterly review' })).toBeVisible()
  },
}

/** The add-customer form opens beside the directory. */
export const CreateCustomer: Story = {
  args: { detail: undefined, editing: storyEditing },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Add customer' }))
    await expect(canvas.getByRole('form', { name: 'Add customer' })).toBeVisible()
  },
}

/** A failed change is announced above the Customer detail. */
export const EditingError: Story = {
  args: {
    editing: { ...storyEditing, errorMessage: createTranslator('en')('customers.edit.error.conflict') },
  },
}
