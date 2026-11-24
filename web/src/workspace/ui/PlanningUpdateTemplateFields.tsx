import {
  PLANNING_UPDATE_REQUIRABLE_FIELDS,
  PLANNING_UPDATE_TEMPLATE_TEXT_FIELDS,
  MAX_PLANNING_UPDATE_TEMPLATE_TEXT_LENGTH,
  type PlanningUpdateRequirableField,
  type PlanningUpdateTemplateSettings,
  type PlanningUpdateTemplateTextField,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Label key of each health update field shown in the editor. */
const fieldLabelKeys: Record<PlanningUpdateRequirableField | PlanningUpdateTemplateTextField, MessageKey> = {
  summary: 'workspace.tenantAdministration.planningUpdateTemplate.field.summary',
  riskSummary: 'workspace.tenantAdministration.planningUpdateTemplate.field.riskSummary',
  decisionSummary: 'workspace.tenantAdministration.planningUpdateTemplate.field.decisionSummary',
  helpNeeded: 'workspace.tenantAdministration.planningUpdateTemplate.field.helpNeeded',
  nextAction: 'workspace.tenantAdministration.planningUpdateTemplate.field.nextAction',
  evidence: 'workspace.tenantAdministration.planningUpdateTemplate.field.evidence',
}

/** Props of the health update template editor. */
export type PlanningUpdateTemplateFieldsProps = {
  /** Settings being edited. */
  settings: PlanningUpdateTemplateSettings
  /** Whether the fields are read-only, for example while the tenant is closing. */
  disabled: boolean
  /** Receives the edited settings. */
  onChange: (settings: PlanningUpdateTemplateSettings) => void
  /** Translator for labels. */
  t: (key: MessageKey) => string
}

/**
 * Edits which health update fields every update must fill in, and the text a new update starts from.
 *
 * @param props - Settings draft, lock state, change callback, and translator.
 * @returns The required-field checkboxes and template text areas.
 */
export function PlanningUpdateTemplateFields({ settings, disabled, onChange, t }: PlanningUpdateTemplateFieldsProps) {
  /**
   * Turns one required field on or off, keeping the display order.
   *
   * @param field - Field to change.
   * @param required - Whether the field becomes required.
   */
  const setRequired = (field: PlanningUpdateRequirableField, required: boolean) => {
    const next = new Set(settings.requiredFields)
    if (required) next.add(field)
    else next.delete(field)
    onChange({
      ...settings,
      requiredFields: PLANNING_UPDATE_REQUIRABLE_FIELDS.filter((candidate) => next.has(candidate)),
    })
  }
  /**
   * Replaces the template text of one field; empty text removes it.
   *
   * @param field - Field whose starting text changes.
   * @param text - New starting text.
   */
  const setTemplate = (field: PlanningUpdateTemplateTextField, text: string) => {
    const template = { ...settings.template }
    if (text) template[field] = text
    else delete template[field]
    onChange({ ...settings, template })
  }
  return (
    <fieldset className="mt-5 grid gap-3" data-testid="tenant-planning-update-template">
      <legend className="text-sm font-semibold text-[var(--workbench-text)]">
        {t('workspace.tenantAdministration.planningUpdateTemplate.title')}
      </legend>
      <p className="text-xs text-[var(--workbench-muted)]">
        {t('workspace.tenantAdministration.planningUpdateTemplate.hint')}
      </p>
      <div
        aria-label={t('workspace.tenantAdministration.planningUpdateTemplate.required')}
        className="flex flex-wrap gap-x-4 gap-y-2"
        role="group"
      >
        {PLANNING_UPDATE_REQUIRABLE_FIELDS.map((field) => (
          <label className="inline-flex items-center gap-1.5 text-sm text-[var(--workbench-text)]" key={field}>
            <input
              checked={settings.requiredFields.includes(field)}
              data-testid={`tenant-planning-update-required-${field}`}
              disabled={disabled}
              onChange={(event) => setRequired(field, event.target.checked)}
              type="checkbox"
            />
            {t(fieldLabelKeys[field])}
          </label>
        ))}
      </div>
      {PLANNING_UPDATE_TEMPLATE_TEXT_FIELDS.map((field) => (
        <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]" key={field}>
          {t('workspace.tenantAdministration.planningUpdateTemplate.templateFor')
            .replace('{field}', t(fieldLabelKeys[field]))}
          <textarea
            className="workbench-input min-h-16 p-2 font-normal"
            data-testid={`tenant-planning-update-template-${field}`}
            disabled={disabled}
            maxLength={MAX_PLANNING_UPDATE_TEMPLATE_TEXT_LENGTH}
            onChange={(event) => setTemplate(field, event.target.value)}
            value={settings.template[field] ?? ''}
          />
        </label>
      ))}
    </fieldset>
  )
}
