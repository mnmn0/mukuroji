import { useState, type KeyboardEvent } from 'react'

/** Input control rendered by an inline task field. */
export type TaskInlineFieldKind = 'text' | 'date' | 'select'

/** Option displayed by an inline task select field. */
export type TaskInlineFieldOption = {
  /** Value sent to the Work Item mutation. */
  value: string
  /** Human-readable option label. */
  label: string
}

/** Props accepted by the shared inline task field. */
export type TaskInlineFieldProps = {
  /** Accessible name for the edit trigger and input. */
  ariaLabel: string
  /** Kind of form control used while editing. */
  kind?: TaskInlineFieldKind
  /** Text shown when the field is not being edited. */
  displayValue: string
  /** Value used to initialize the form control. */
  value: string
  /** Options used by a select field. */
  options?: readonly TaskInlineFieldOption[]
  /** Error text shown after a failed commit. */
  errorMessage?: string
  /** Canonical task field copied by the table fill-down shortcut. */
  fieldKey?: string
  /** Stable test identifier for the field. */
  testId?: string
  /** Commits the changed value through the shared Work Item action. */
  onCommit: (value: string) => Promise<void>
}

/**
 * Renders a click-, keyboard-, and touch-accessible inline editor.
 *
 * @param props - Display value, control configuration, and commit callback.
 * @returns A compact read-only trigger or its active form control.
 */
export function TaskInlineField({
  ariaLabel,
  displayValue,
  errorMessage,
  fieldKey,
  kind = 'text',
  onCommit,
  options = [],
  testId,
  value,
}: TaskInlineFieldProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [isSaving, setIsSaving] = useState(false)

  /** Starts editing from the latest value supplied by the parent. */
  const startEditing = () => {
    setDraft(value)
    setIsEditing(true)
  }

  /** Cancels the current draft without sending a mutation. */
  const cancelEditing = () => {
    if (isSaving) {
      return
    }

    setDraft(value)
    setIsEditing(false)
  }

  /** Commits a changed value and leaves the control open when the mutation fails. */
  const commit = async (nextValue = draft) => {
    if (isSaving) {
      return
    }

    if (nextValue === value) {
      setIsEditing(false)
      return
    }

    setIsSaving(true)

    try {
      await onCommit(nextValue)
      setIsEditing(false)
    } catch {
      // The parent action owns the localized failure feedback; keep the editor open.
    } finally {
      setIsSaving(false)
    }
  }

  if (!isEditing) {
    return (
      <button
        aria-label={ariaLabel}
        className="inline-flex min-w-0 max-w-full truncate rounded px-1.5 py-0.5 text-left transition hover:bg-[#e5f7f4] hover:text-[var(--workbench-primary)] focus:outline-none focus:ring-2 focus:ring-[#2563eb]/20"
        data-task-field={fieldKey}
        data-testid={testId}
        onClick={startEditing}
        title={errorMessage ?? ariaLabel}
        type="button"
      >
        {displayValue}
      </button>
    )
  }

  const commonProps = {
    'aria-label': ariaLabel,
    autoFocus: true,
    className: 'workbench-input h-8 min-w-0 px-2 text-xs',
    'data-task-field': fieldKey,
    'data-testid': testId ? `${testId}-input` : undefined,
    disabled: isSaving,
    onBlur: () => {
      if (kind === 'select') {
        cancelEditing()
      } else {
        void commit()
      }
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancelEditing()
      } else if (event.key === 'Enter' && kind !== 'select') {
        event.preventDefault()
        void commit()
      }
    },
  }

  if (kind === 'select') {
    return (
      <select
        {...commonProps}
        onChange={(event) => {
          setDraft(event.target.value)
          void commit(event.target.value)
        }}
        value={draft}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    )
  }

  return (
    <input
      {...commonProps}
      onChange={(event) => setDraft(event.target.value)}
      type={kind}
      value={draft}
    />
  )
}
