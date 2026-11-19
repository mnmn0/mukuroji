import { useState, type ReactNode } from 'react'
import type {
  CreateCustomerContactInput,
  CreateCustomerInput,
  Customer,
  CustomerContact,
  CustomerRequest,
  CustomerRequestWorkItemLink,
  UpdateCustomerContactInput,
  UpdateCustomerInput,
  UpdateCustomerRequestInput,
} from '@mukuroji/contracts'
import type { CreateCustomerRequestBody } from '../api/customers'
import {
  createCustomerContactDraft,
  createCustomerDraft,
  createCustomerRequestDraft,
  readCreateCustomerContactInput,
  readCreateCustomerInput,
  readCreateCustomerRequestInput,
  readUpdateCustomerContactInput,
  readUpdateCustomerInput,
  readUpdateCustomerRequestInput,
  type CustomerDraftIssue,
  type CustomerDraftResult,
} from '../model/customerDrafts'
import {
  customerHealthOptions,
  customerSizeOptions,
  customerStatusOptions,
  customerTierOptions,
  requestEditableStatusOptions,
  requestImportanceOptions,
  requestManualSourceOptions,
  type CustomerFilterOption,
} from '../model/customerOptions'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Project the member can link a Customer Request to. */
export type CustomerProjectOption = {
  /** Canonical Project identifier. */
  id: string
  /** Project display name. */
  name: string
}

/** Editing state and operations the Customer view shows to members who may change Customers. */
export type CustomerEditingProps = {
  /** Whether a change is being sent. */
  isSaving: boolean
  /** Message for the latest failed change, when any. */
  errorMessage?: string
  /** Projects offered when linking a Customer Request. */
  projects: readonly CustomerProjectOption[]
  /** Creates a Customer. Resolves true when it was created. */
  onCreateCustomer: (input: CreateCustomerInput) => Promise<boolean>
  /** Updates a Customer. */
  onUpdateCustomer: (customerId: string, input: UpdateCustomerInput) => Promise<boolean>
  /** Adds a contact to a Customer. */
  onCreateContact: (customerId: string, input: CreateCustomerContactInput) => Promise<boolean>
  /** Updates a contact. */
  onUpdateContact: (contact: CustomerContact, input: UpdateCustomerContactInput) => Promise<boolean>
  /** Deletes a contact. */
  onDeleteContact: (contact: CustomerContact) => Promise<boolean>
  /** Records a Customer Request. */
  onCreateRequest: (input: CreateCustomerRequestBody) => Promise<boolean>
  /** Updates a Customer Request. */
  onUpdateRequest: (request: CustomerRequest, input: UpdateCustomerRequestInput) => Promise<boolean>
  /** Links a Customer Request to the Work Item named by a key. */
  onLinkWorkItem: (request: CustomerRequest, workItemKey: string) => Promise<boolean>
  /** Removes a Work Item link. */
  onUnlinkWorkItem: (request: CustomerRequest, link: CustomerRequestWorkItemLink) => Promise<boolean>
  /** Links a Customer Request to a Project. */
  onLinkProject: (request: CustomerRequest, projectId: string) => Promise<boolean>
  /** Removes a Project link. */
  onUnlinkProject: (request: CustomerRequest, projectId: string) => Promise<boolean>
}

/** Translator used by every editor. */
type Translate = (key: MessageKey) => string

/** Message keys for draft validation problems. */
const draftIssueLabels: Record<CustomerDraftIssue, MessageKey> = {
  nameRequired: 'customers.edit.issue.nameRequired',
  domainInvalid: 'customers.edit.issue.domainInvalid',
  businessValueInvalid: 'customers.edit.issue.businessValueInvalid',
  emailInvalid: 'customers.edit.issue.emailInvalid',
  messageRequired: 'customers.edit.issue.messageRequired',
  receivedAtInvalid: 'customers.edit.issue.receivedAtInvalid',
}

/**
 * Validates a draft and sends it, keeping the validation problem for the form to show.
 *
 * @returns The current problem and a submit helper.
 */
function useDraftSubmission() {
  const [issue, setIssue] = useState<CustomerDraftIssue>()
  return {
    issue,
    /**
     * Sends a valid draft, or records why it cannot be sent.
     *
     * @param result Validated draft.
     * @param send Sends the validated input.
     * @param onDone Runs after a successful send.
     */
    submit: async <Input,>(
      result: CustomerDraftResult<Input>,
      send: (input: Input) => Promise<boolean>,
      onDone: () => void,
    ) => {
      if (!result.ok) {
        setIssue(result.issue)
        return
      }
      setIssue(undefined)
      if (await send(result.input)) onDone()
    },
  }
}

/**
 * Renders the Customer create or edit form.
 *
 * @param props Customer being edited, when any, and the form callbacks.
 * @returns The Customer form.
 */
export function CustomerForm({
  customer,
  isSaving,
  onCancel,
  onCreate,
  onUpdate,
  t,
}: {
  /** Customer being edited. Leave out to create a new one. */
  customer?: Customer
  /** Whether a change is being sent. */
  isSaving: boolean
  /** Closes the form without saving. */
  onCancel: () => void
  /** Creates a Customer. */
  onCreate?: (input: CreateCustomerInput) => Promise<boolean>
  /** Updates the Customer. */
  onUpdate?: (customerId: string, input: UpdateCustomerInput) => Promise<boolean>
  /** Translator for form copy. */
  t: Translate
}) {
  // The draft and the record it was made from stay together, so a later refresh never becomes the
  // revision baseline for edits made against older data.
  const [baseline] = useState(customer)
  const [draft, setDraft] = useState(() => createCustomerDraft(baseline))
  const { issue, submit } = useDraftSubmission()
  const title = t(customer ? 'customers.edit.editTitle' : 'customers.edit.createTitle')
  return (
    <EditorForm
      issue={issue}
      isSaving={isSaving}
      onCancel={onCancel}
      onSubmit={() => {
        if (baseline && onUpdate) {
          void submit(readUpdateCustomerInput(baseline, draft), (input) => onUpdate(baseline.id, input), onCancel)
        } else if (onCreate) {
          void submit(readCreateCustomerInput(draft), onCreate, onCancel)
        }
      }}
      submitLabel={t(customer ? 'customers.edit.save' : 'customers.edit.create')}
      t={t}
      title={title}
    >
      <TextField label={t('customers.edit.name')} onChange={(name) => setDraft({ ...draft, name })} required value={draft.name} />
      <TextField
        label={t('customers.edit.domain')}
        onChange={(domain) => setDraft({ ...draft, domain })}
        placeholder={t('customers.edit.domainPlaceholder')}
        value={draft.domain}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField label={t('customers.tier')} onChange={(tier) => setDraft({ ...draft, tier })} options={customerTierOptions} t={t} value={draft.tier} />
        <SelectField label={t('customers.size')} onChange={(size) => setDraft({ ...draft, size })} options={customerSizeOptions} t={t} value={draft.size} />
        <SelectField label={t('customers.status')} onChange={(status) => setDraft({ ...draft, status })} options={customerStatusOptions} t={t} value={draft.status} />
        <SelectField label={t('customers.health')} onChange={(health) => setDraft({ ...draft, health })} options={customerHealthOptions} t={t} value={draft.health} />
      </div>
      <p className="text-xs text-[var(--workbench-muted)]">{t('customers.edit.statusHint')}</p>
      <TextField
        inputMode="decimal"
        label={t('customers.businessValue')}
        onChange={(businessValue) => setDraft({ ...draft, businessValue })}
        value={draft.businessValue}
      />
      <TextAreaField label={t('customers.edit.notes')} onChange={(notes) => setDraft({ ...draft, notes })} value={draft.notes} />
    </EditorForm>
  )
}

/**
 * Renders the contact create or edit form.
 *
 * @param props Contact being edited, when any, and the form callbacks.
 * @returns The contact form.
 */
export function CustomerContactForm({
  contact,
  customerId,
  editing,
  onClose,
  t,
}: {
  /** Contact being edited. Leave out to add a new one. */
  contact?: CustomerContact
  /** Customer the contact belongs to. */
  customerId: string
  /** Editing operations. */
  editing: CustomerEditingProps
  /** Closes the form. */
  onClose: () => void
  /** Translator for form copy. */
  t: Translate
}) {
  const [baseline] = useState(contact)
  const [draft, setDraft] = useState(() => createCustomerContactDraft(baseline))
  const { issue, submit } = useDraftSubmission()
  return (
    <EditorForm
      issue={issue}
      isSaving={editing.isSaving}
      onCancel={onClose}
      onSubmit={() => {
        if (baseline) {
          void submit(readUpdateCustomerContactInput(baseline, draft), (input) => editing.onUpdateContact(baseline, input), onClose)
        } else {
          void submit(readCreateCustomerContactInput(draft), (input) => editing.onCreateContact(customerId, input), onClose)
        }
      }}
      submitLabel={t(contact ? 'customers.edit.save' : 'customers.edit.create')}
      t={t}
      title={t(contact ? 'customers.edit.contactFormTitle' : 'customers.edit.addContact')}
    >
      <TextField label={t('customers.edit.name')} onChange={(name) => setDraft({ ...draft, name })} required value={draft.name} />
      <TextField label={t('customers.edit.contactEmail')} onChange={(email) => setDraft({ ...draft, email })} type="email" value={draft.email} />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={t('customers.edit.contactRole')} onChange={(role) => setDraft({ ...draft, role })} value={draft.role} />
        <TextField label={t('customers.edit.contactPhone')} onChange={(phone) => setDraft({ ...draft, phone })} type="tel" value={draft.phone} />
      </div>
      <label className="flex items-center gap-2 text-sm text-[var(--workbench-text)]">
        <input
          checked={draft.primary}
          onChange={(event) => setDraft({ ...draft, primary: event.target.checked })}
          type="checkbox"
        />
        {t('customers.edit.contactPrimary')}
      </label>
    </EditorForm>
  )
}

/**
 * Renders the Customer Request create or edit form.
 *
 * @param props Request being edited, when any, the Customer's contacts, and the form callbacks.
 * @returns The Customer Request form.
 */
export function CustomerRequestForm({
  contacts,
  customerId,
  editing,
  onClose,
  request,
  t,
}: {
  /** Contacts the Request can be attributed to. */
  contacts: readonly CustomerContact[]
  /** Customer the Request belongs to. */
  customerId: string
  /** Editing operations. */
  editing: CustomerEditingProps
  /** Closes the form. */
  onClose: () => void
  /** Request being edited. Leave out to record a new one. */
  request?: CustomerRequest
  /** Translator for form copy. */
  t: Translate
}) {
  const [baseline] = useState(request)
  const [draft, setDraft] = useState(() => createCustomerRequestDraft(baseline))
  const { issue, submit } = useDraftSubmission()
  const contactOptions = contacts.filter((contact) => contact.status === 'active' || contact.id === request?.contactId)
  return (
    <EditorForm
      issue={issue}
      isSaving={editing.isSaving}
      onCancel={onClose}
      onSubmit={() => {
        if (baseline) {
          void submit(readUpdateCustomerRequestInput(baseline, draft), (input) => editing.onUpdateRequest(baseline, input), onClose)
        } else {
          void submit(readCreateCustomerRequestInput(customerId, draft), editing.onCreateRequest, onClose)
        }
      }}
      submitLabel={t(request ? 'customers.edit.save' : 'customers.edit.create')}
      t={t}
      title={t(request ? 'customers.edit.requestFormTitle' : 'customers.edit.addRequest')}
    >
      <TextAreaField
        label={t('customers.edit.requestMessage')}
        onChange={(originalMessage) => setDraft({ ...draft, originalMessage })}
        required
        value={draft.originalMessage}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={t('customers.edit.requestReceivedAt')}
          onChange={(receivedAt) => setDraft({ ...draft, receivedAt })}
          required
          type="datetime-local"
          value={draft.receivedAt}
        />
        <SelectField
          label={t('customers.edit.requestImportance')}
          onChange={(importance) => setDraft({ ...draft, importance })}
          options={requestImportanceOptions}
          t={t}
          value={draft.importance}
        />
        {request ? (
          request.status === 'merged' ? null : (
            <SelectField
              label={t('customers.edit.requestStatus')}
              onChange={(status) => setDraft({ ...draft, status })}
              options={requestEditableStatusOptions}
              t={t}
              value={draft.status}
            />
          )
        ) : (
          <SelectField
            label={t('customers.edit.requestSource')}
            onChange={(sourceKind) => setDraft({ ...draft, sourceKind })}
            options={requestManualSourceOptions}
            t={t}
            value={draft.sourceKind}
          />
        )}
        <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
          <span>{t('customers.edit.requestContact')}</span>
          <select
            className="workbench-input min-h-10 w-full"
            onChange={(event) => setDraft({ ...draft, contactId: event.target.value })}
            value={draft.contactId}
          >
            <option value="">{t('customers.edit.requestNoContact')}</option>
            {contactOptions.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}
          </select>
        </label>
      </div>
    </EditorForm>
  )
}

/**
 * Lists a Customer Request's Work Item and Project links with controls to add and remove them.
 *
 * @param props Request, editing operations, and translator.
 * @returns The link editor.
 */
export function CustomerRequestLinksEditor({
  editing,
  request,
  t,
}: {
  /** Editing operations and the Project options. */
  editing: CustomerEditingProps
  /** Request whose links are shown. */
  request: CustomerRequest
  /** Translator for link copy. */
  t: Translate
}) {
  const [workItemKey, setWorkItemKey] = useState('')
  const [projectId, setProjectId] = useState('')
  const projectNames = new Map(editing.projects.map((project) => [project.id, project.name]))
  const linkedProjectIds = new Set(request.projectLinks.map((link) => link.projectId))
  const availableProjects = editing.projects.filter((project) => !linkedProjectIds.has(project.id))
  const hasLinks = request.workItemLinks.length > 0 || request.projectLinks.length > 0
  return (
    <div className="mt-3 grid gap-2 border-t border-[var(--workbench-border)] pt-3">
      <p className="text-xs font-semibold text-[var(--workbench-muted)]">{t('customers.edit.links')}</p>
      {hasLinks ? (
        <ul className="grid gap-1">
          {request.workItemLinks.map((link) => {
            const label = t('customers.edit.linkedWorkItem').replace('{id}', link.workItemId)
            return (
              <LinkRow
                disabled={editing.isSaving}
                key={`work-item:${link.teamId}:${link.workItemId}`}
                label={label}
                onUnlink={() => void editing.onUnlinkWorkItem(request, link)}
                t={t}
              />
            )
          })}
          {request.projectLinks.map((link) => {
            const label = t('customers.edit.linkedProject').replace('{name}', projectNames.get(link.projectId) ?? link.projectId)
            return (
              <LinkRow
                disabled={editing.isSaving}
                key={`project:${link.projectId}`}
                label={label}
                onUnlink={() => void editing.onUnlinkProject(request, link.projectId)}
                t={t}
              />
            )
          })}
        </ul>
      ) : (
        <p className="text-xs text-[var(--workbench-muted)]">{t('customers.edit.noLinks')}</p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!workItemKey.trim() || editing.isSaving) return
            void editing.onLinkWorkItem(request, workItemKey).then((linked) => {
              if (linked) setWorkItemKey('')
            })
          }}
        >
          <label className="grid min-w-0 flex-1 gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
            <span>{t('customers.edit.workItemKey')}</span>
            <input
              className="workbench-input min-h-9 w-full"
              onChange={(event) => setWorkItemKey(event.target.value)}
              placeholder={t('customers.edit.workItemKeyPlaceholder')}
              value={workItemKey}
            />
          </label>
          <button className="workbench-button-secondary min-h-9 px-3 text-xs" disabled={!workItemKey.trim() || editing.isSaving} type="submit">
            {t('customers.edit.linkWorkItem')}
          </button>
        </form>
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!projectId || editing.isSaving) return
            void editing.onLinkProject(request, projectId).then((linked) => {
              if (linked) setProjectId('')
            })
          }}
        >
          <label className="grid min-w-0 flex-1 gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
            <span>{t('customers.edit.project')}</span>
            <select className="workbench-input min-h-9 w-full" onChange={(event) => setProjectId(event.target.value)} value={projectId}>
              <option value="">{t('customers.edit.chooseProject')}</option>
              {availableProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <button className="workbench-button-secondary min-h-9 px-3 text-xs" disabled={!projectId || editing.isSaving} type="submit">
            {t('customers.edit.linkProject')}
          </button>
        </form>
      </div>
    </div>
  )
}

/**
 * Renders a delete button that asks for a second click before it deletes.
 *
 * @param props Accessible name, state, and delete callback.
 * @returns The two-step delete button.
 */
export function ConfirmDeleteButton({
  disabled,
  label,
  onDelete,
  t,
}: {
  /** Whether a change is being sent. */
  disabled: boolean
  /** Accessible name of the first button, such as "Delete Mina". */
  label: string
  /** Deletes the record. */
  onDelete: () => void
  /** Translator for button copy. */
  t: Translate
}) {
  const [isConfirming, setIsConfirming] = useState(false)
  if (!isConfirming) {
    return (
      <button aria-label={label} className="workbench-button-secondary min-h-8 px-3 text-xs" disabled={disabled} onClick={() => setIsConfirming(true)} type="button">
        {t('customers.edit.delete')}
      </button>
    )
  }
  return (
    <span className="flex gap-2">
      <button className="min-h-8 rounded-md border border-red-200 bg-red-50 px-3 text-xs font-semibold text-fg-red-700" disabled={disabled} onClick={onDelete} type="button">
        {t('customers.edit.confirmDelete')}
      </button>
      <button className="workbench-button-secondary min-h-8 px-3 text-xs" onClick={() => setIsConfirming(false)} type="button">
        {t('customers.edit.cancel')}
      </button>
    </span>
  )
}

/** Renders one linked target with its unlink button. */
function LinkRow({
  disabled,
  label,
  onUnlink,
  t,
}: {
  /** Whether a change is being sent. */
  disabled: boolean
  /** Linked target label. */
  label: string
  /** Removes the link. */
  onUnlink: () => void
  /** Translator for button copy. */
  t: Translate
}) {
  return (
    <li className="flex items-center justify-between gap-2 rounded-md bg-[var(--workbench-surface-muted)] px-2 py-1 text-xs text-[var(--workbench-text)]">
      <span className="min-w-0 truncate">{label}</span>
      <button
        aria-label={t('customers.edit.unlinkNamed').replace('{name}', label)}
        className="workbench-button-secondary min-h-7 px-2 text-xs"
        disabled={disabled}
        onClick={onUnlink}
        type="button"
      >
        {t('customers.edit.unlink')}
      </button>
    </li>
  )
}

/** Renders the shared frame of an editor form: title, fields, validation problem, and actions. */
function EditorForm({
  children,
  issue,
  isSaving,
  onCancel,
  onSubmit,
  submitLabel,
  t,
  title,
}: {
  /** Form fields. */
  children: ReactNode
  /** Current validation problem. */
  issue?: CustomerDraftIssue
  /** Whether a change is being sent. */
  isSaving: boolean
  /** Closes the form. */
  onCancel: () => void
  /** Validates and sends the draft. */
  onSubmit: () => void
  /** Submit button label. */
  submitLabel: string
  /** Translator for form copy. */
  t: Translate
  /** Accessible form name. */
  title: string
}) {
  return (
    <form
      aria-label={title}
      className="grid gap-3 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (!isSaving) onSubmit()
      }}
    >
      <p className="text-sm font-bold text-[var(--workbench-text)]">{title}</p>
      {children}
      {issue ? <p className="text-sm font-semibold text-fg-red-700" role="alert">{t(draftIssueLabels[issue])}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button className="workbench-button-secondary min-h-9 px-3 text-xs" onClick={onCancel} type="button">
          {t('customers.edit.cancel')}
        </button>
        <button className="workbench-button-primary min-h-9 px-3 text-xs" disabled={isSaving} type="submit">
          {isSaving ? t('customers.edit.saving') : submitLabel}
        </button>
      </div>
    </form>
  )
}

/** Renders one labelled text input. */
function TextField({
  inputMode,
  label,
  onChange,
  placeholder,
  required,
  type = 'text',
  value,
}: {
  /** Virtual keyboard hint. */
  inputMode?: 'decimal'
  /** Visible label. */
  label: string
  /** Receives the new value. */
  onChange: (value: string) => void
  /** Example value. */
  placeholder?: string
  /** Whether the field is required. */
  required?: boolean
  /** Input type. */
  type?: 'text' | 'email' | 'tel' | 'datetime-local'
  /** Current value. */
  value: string
}) {
  return (
    <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
      <span>{label}</span>
      <input
        className="workbench-input min-h-10 w-full"
        inputMode={inputMode}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        type={type}
        value={value}
      />
    </label>
  )
}

/** Renders one labelled multi-line text input. */
function TextAreaField({
  label,
  onChange,
  required,
  value,
}: {
  /** Visible label. */
  label: string
  /** Receives the new value. */
  onChange: (value: string) => void
  /** Whether the field is required. */
  required?: boolean
  /** Current value. */
  value: string
}) {
  return (
    <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
      <span>{label}</span>
      <textarea
        className="workbench-input min-h-20 w-full py-2"
        onChange={(event) => onChange(event.target.value)}
        required={required}
        value={value}
      />
    </label>
  )
}

/** Renders one labelled select over a fixed set of typed options. */
function SelectField<Value extends string>({
  label,
  onChange,
  options,
  t,
  value,
}: {
  /** Visible label. */
  label: string
  /** Receives the chosen option. */
  onChange: (value: Value) => void
  /** Options to offer. */
  options: readonly CustomerFilterOption<Value>[]
  /** Translator for option labels. */
  t: Translate
  /** Current value. */
  value: Value
}) {
  return (
    <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
      <span>{label}</span>
      <select
        className="workbench-input min-h-10 w-full"
        onChange={(event) => {
          const option = options.find((candidate) => candidate.value === event.target.value)
          if (option) onChange(option.value)
        }}
        value={value}
      >
        {options.map((option) => <option key={option.value} value={option.value}>{t(option.labelKey)}</option>)}
      </select>
    </label>
  )
}
