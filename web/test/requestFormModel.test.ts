import type { RequestForm } from '@mukuroji/contracts'
import { describe, expect, test } from 'bun:test'
import {
  publicRequestFormFixture,
  requestFormFixture,
  requestSubmissionFixture,
} from '../src/requests/fixtures'
import {
  createEmptyRequestFormDraft,
  createRequestFormInput,
  isRequestFormDraftModelValid,
  normalizeRequestBuilderFieldForType,
  normalizeRequestForm,
  normalizePublicRequestForm,
  normalizeRequestSubmission,
  persistAndPublishRequestForm,
  updateRequestFormInput,
} from '../src/requests/model'

describe('request form model round-trip', () => {
  test('preserves ordered routing rules and custom field mappings', () => {
    const input = updateRequestFormInput(normalizeRequestForm(requestFormFixture))

    expect(input.draft?.routing.rules).toEqual(requestFormFixture.draft.routing.rules)
    expect(input.draft?.routing.mapping.customFieldMappings).toEqual(
      requestFormFixture.draft.routing.mapping.customFieldMappings,
    )
  })

  test('omits blank optional localized values, consent, and attachment policy', () => {
    const model = createEmptyRequestFormDraft()
    model.name = 'Support intake'
    model.title.ja = 'サポート受付'
    model.confirmation.ja = '受け付けました。'
    const section = model.sections[0]
    const field = section?.fields[0]
    if (!section || !field) throw new Error('Empty request form fixture is incomplete.')
    section.title.ja = '依頼内容'
    field.label.ja = '概要'
    model.routing.teamId = 'core-team'
    model.routing.assigneeUserId = 'triage@example.com'
    model.routing.titleFieldId = field.id

    expect(isRequestFormDraftModelValid(model)).toBe(true)

    const definition = createRequestFormInput(model).draft.definition
    expect(definition.title).toEqual({ ja: 'サポート受付' })
    expect(definition.description).toBeUndefined()
    expect(definition.consent).toBeUndefined()
    expect(definition.attachments).toBeUndefined()
    expect(definition.sections[0]?.description).toBeUndefined()
    expect(definition.sections[0]?.fields[0]?.helpText).toBeUndefined()
    expect(definition.sections[0]?.fields[0]?.placeholder).toBeUndefined()
  })

  test('rejects a draft whose required text exists only outside the default locale', () => {
    const model = createEmptyRequestFormDraft()
    model.name = 'Support intake'
    model.title.en = 'Support intake'
    model.confirmation.en = 'Received.'
    const section = model.sections[0]
    const field = section?.fields[0]
    if (!section || !field) throw new Error('Empty request form fixture is incomplete.')
    section.title.en = 'Details'
    field.label.en = 'Summary'
    model.routing.teamId = 'core-team'
    model.routing.assigneeUserId = 'triage@example.com'
    model.routing.titleFieldId = field.id

    expect(isRequestFormDraftModelValid(model)).toBe(false)
  })

  test('keeps public session expiry and minimum submit timing for renewal UI', () => {
    const model = normalizePublicRequestForm(publicRequestFormFixture)

    expect(model.sessionExpiresAt).toBe(publicRequestFormFixture.submissionSession.expiresAt)
    expect(model.minimumSubmitAt).toBe(publicRequestFormFixture.submissionSession.minimumSubmitAt)
  })

  test('normalizes stale options and validation when a field type changes', () => {
    const model = normalizeRequestForm(requestFormFixture)
    const field = model.sections[0]?.fields[1]
    if (!field) throw new Error('Request form fixture needs a select field.')
    field.validation = {
      max: 10,
      maxLength: 20,
      min: 1,
      minLength: 2,
      pattern: '^bug$',
    }

    const numberField = normalizeRequestBuilderFieldForType(field, 'number')
    expect(numberField.options).toEqual([])
    expect(numberField.validation).toEqual({ max: 10, min: 1 })

    const textField = normalizeRequestBuilderFieldForType(numberField, 'text')
    expect(textField.options).toEqual([])
    expect(textField.validation).toBeUndefined()
  })

  test('preserves text-like patterns when an existing draft is round-tripped', () => {
    const formWithPattern = structuredClone(requestFormFixture)
    const emailField = formWithPattern.draft.definition.sections[0]?.fields[0]
    if (!emailField) throw new Error('Request form fixture needs an email field.')
    emailField.validation = {
      ...emailField.validation,
      maxLength: 320,
      pattern: '^[^@]+@example\\.com$',
    }

    const input = updateRequestFormInput(normalizeRequestForm(formWithPattern))
    const roundTrippedField = input.draft?.definition.sections[0]?.fields[0]

    expect(roundTrippedField?.validation).toEqual({
      maxLength: 320,
      pattern: '^[^@]+@example\\.com$',
      required: true,
    })
  })

  test('keeps historical option labels with normalized submission answers', () => {
    const model = normalizeRequestSubmission(requestSubmissionFixture)
    const answer = model.answers.find((candidate) => candidate.fieldId === 'request-kind')

    expect(model.formDefaultLocale).toBe('ja')
    expect(answer?.options).toEqual([
      { id: 'bug', label: { en: 'Bug', ja: '不具合' } },
      { id: 'question', label: { en: 'Question', ja: '質問' } },
    ])
  })

  test('rejects field and section conditions that refer to later fields', () => {
    const model = normalizeRequestForm(requestFormFixture)
    const firstSection = model.sections[0]
    const firstField = firstSection?.fields[0]
    const laterField = firstSection?.fields[1]
    if (!firstSection || !firstField || !laterField) {
      throw new Error('Request form fixture needs fields in two sections.')
    }

    firstField.condition = {
      match: 'all',
      rules: [{ fieldId: laterField.id, operator: 'equals', value: 'later' }],
    }
    expect(isRequestFormDraftModelValid(model)).toBe(false)

    firstField.condition = undefined
    firstSection.condition = {
      match: 'all',
      rules: [{ fieldId: laterField.id, operator: 'equals', value: 'later' }],
    }
    expect(isRequestFormDraftModelValid(model)).toBe(false)
  })

  test('rejects duplicate custom field mapping targets', () => {
    const model = normalizeRequestForm(requestFormFixture)
    const fields = model.sections.flatMap((section) => section.fields)
    const firstField = fields[0]
    const secondField = fields[1]
    if (!firstField || !secondField) throw new Error('Request form fixture needs two fields.')

    model.routing.customFieldMappings = {
      [firstField.id]: 'customer-impact',
      [secondField.id]: 'customer-impact',
    }

    expect(isRequestFormDraftModelValid(model)).toBe(false)
  })

  test('persists the current draft before publishing the returned revision', async () => {
    const model = normalizeRequestForm(requestFormFixture)
    const calls: string[] = []

    const published = await persistAndPublishRequestForm(
      model,
      async (input) => {
        calls.push(`persist:${input.expectedRevision}`)
        return { ...requestFormFixture, revision: 8 }
      },
      async (expectedRevision) => {
        calls.push(`publish:${expectedRevision}`)
        return { ...requestFormFixture, revision: 9 }
      },
      () => {
        throw new Error('Successful publishing must not retain an intermediate revision.')
      },
    )

    expect(calls).toEqual([`persist:${model.revision}`, 'publish:8'])
    expect(published.revision).toBe(9)
  })

  test('retains the persisted revision after publishing is rejected', async () => {
    const model = normalizeRequestForm(requestFormFixture)
    let retainedModel = model
    let rejectPublishing = true
    const persistedRevisions: number[] = []
    const publishedRevisions: number[] = []

    const persist = async (input: ReturnType<typeof updateRequestFormInput>) => {
      persistedRevisions.push(input.expectedRevision)
      return { ...requestFormFixture, revision: input.expectedRevision + 1 }
    }
    const publish = async (expectedRevision: number) => {
      publishedRevisions.push(expectedRevision)
      if (rejectPublishing) throw new Error('Publishing was rejected.')
      return { ...requestFormFixture, revision: expectedRevision + 1 }
    }
    const retainPersistedForm = (persisted: RequestForm) => {
      retainedModel = normalizeRequestForm(persisted)
    }

    await expect(persistAndPublishRequestForm(
      model,
      persist,
      publish,
      retainPersistedForm,
    )).rejects.toThrow('Publishing was rejected.')

    expect(retainedModel.revision).toBe(model.revision + 1)

    rejectPublishing = false
    const published = await persistAndPublishRequestForm(
      retainedModel,
      persist,
      publish,
      retainPersistedForm,
    )

    expect(persistedRevisions).toEqual([model.revision, model.revision + 1])
    expect(publishedRevisions).toEqual([model.revision + 1, model.revision + 2])
    expect(published.revision).toBe(model.revision + 3)
  })
})
