import type { DeveloperPlatformOption } from './DeveloperPlatformView'

/**
 * Renders a required text-like input with a localized label.
 *
 * @param props - Input value, display text, type, and change callback.
 * @returns The labeled input UI.
 */
export function TextField(props: {
  autoFocus?: boolean
  label: string
  placeholder: string
  type?: 'text' | 'url'
  value: string
  onChange: (value: string) => void
}) {
  const {
    autoFocus,
    label,
    placeholder,
    type = 'text',
    value,
    onChange,
  } = props

  return (
    <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
      {label}
      <input
        autoFocus={autoFocus}
        className="workbench-input min-h-10 px-3 normal-case tracking-normal"
        placeholder={placeholder}
        required
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

/**
 * Renders a checkbox list for a typed collection of Developer Platform options.
 *
 * @param props - Checklist configuration, selected values, and change callback.
 * @returns The option checklist UI.
 */
export function OptionChecklist<TValue extends string>(props: {
  disabled?: boolean
  errorMessage?: string
  legend: string
  options: DeveloperPlatformOption<TValue>[]
  value: TValue[]
  onChange: (value: TValue[]) => void
}) {
  const {
    disabled = false,
    errorMessage,
    legend,
    options,
    value,
    onChange,
  } = props

  return (
    <fieldset className="grid gap-2">
      <legend className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
        {legend}
      </legend>
      <div className="grid gap-2">
        {options.map((option) => (
          <label
            className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[var(--workbench-border)] bg-white px-3 py-2"
            key={option.value}
          >
            <span className="min-w-0">
              <strong className="block text-sm font-semibold text-[var(--workbench-text)]">
                {option.label}
              </strong>
              <span className="mt-0.5 block text-xs font-medium text-[var(--workbench-muted)]">
                {option.description}
              </span>
            </span>
            <input
              checked={value.includes(option.value)}
              className="h-5 w-5 flex-none accent-[var(--workbench-primary)] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={disabled}
              type="checkbox"
              onChange={() => onChange(toggleSelection(value, option.value))}
            />
          </label>
        ))}
      </div>
      {errorMessage ? (
        <p className="text-xs font-semibold text-red-700" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </fieldset>
  )
}

/**
 * Toggles one value in an immutable selection array.
 *
 * @param current - Current selected values.
 * @param value - Value to add or remove.
 * @returns A new selection array with the value toggled.
 */
function toggleSelection<TValue>(current: TValue[], value: TValue) {
  return current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value]
}
