import { describe, expect, test } from 'bun:test'
import {
  filterVisibleRequestAnswers,
  getVisibleRequestFieldIds,
  isCurrentPublicRequestFormRequest,
  matchesRequestVisibilityCondition,
  resolveRequestFormLocale,
  resolveRequestLocalizedText,
  selectRemainingRequestAttachmentFiles,
  selectRequestAttachmentClaims,
  updatePendingRequestAttachmentFields,
  validateVisibleRequestAnswers,
  type RequestFormLogicVersion,
} from '../src/requests/requestFormLogic'

const formVersion: RequestFormLogicVersion = {
  defaultLocale: 'ja',
  locales: ['ja', 'en'],
  sections: [
    {
      id: 'contact',
      fields: [
        { id: 'email', required: true, type: 'email' },
        {
          id: 'kind',
          optionIds: ['bug', 'question'],
          required: true,
          type: 'select',
        },
        {
          condition: {
            match: 'all',
            rules: [
              { fieldId: 'kind', operator: 'equals', value: 'bug' },
              { fieldId: 'email', operator: 'is-not-empty' },
            ],
          },
          id: 'steps',
          required: true,
          type: 'textarea',
          validation: { minLength: 8 },
        },
      ],
    },
    {
      condition: {
        match: 'any',
        rules: [
          { fieldId: 'kind', operator: 'equals', value: 'question' },
          { fieldId: 'steps', operator: 'contains', value: 'urgent' },
        ],
      },
      fields: [{ id: 'consent', required: true, type: 'checkbox' }],
      id: 'consent-section',
    },
  ],
}

describe('request form locale resolution', () => {
  test('uses exact, language, default, and first locale fallbacks', () => {
    expect(resolveRequestFormLocale(formVersion, 'en-US')).toBe('en')
    expect(resolveRequestFormLocale(formVersion, 'fr')).toBe('ja')
    expect(resolveRequestFormLocale({ defaultLocale: '', locales: ['en'] }, undefined)).toBe('en')
  })

  test('resolves localized text without returning a blank translation', () => {
    const text = { en: 'Request help', ja: '依頼する' }

    expect(resolveRequestLocalizedText(text, 'en-US', 'ja')).toBe('Request help')
    expect(resolveRequestLocalizedText({ en: '', ja: '依頼する' }, 'en', 'ja')).toBe('依頼する')
  })
})

describe('request form conditional logic', () => {
  test('supports all and any conditions', () => {
    expect(matchesRequestVisibilityCondition({
      match: 'all',
      rules: [
        { fieldId: 'kind', operator: 'equals', value: 'bug' },
        { fieldId: 'email', operator: 'is-not-empty' },
      ],
    }, { email: 'demo@example.com', kind: 'bug' })).toBe(true)

    expect(matchesRequestVisibilityCondition({
      match: 'any',
      rules: [
        { fieldId: 'kind', operator: 'equals', value: 'question' },
        { fieldId: 'steps', operator: 'contains', value: 'urgent' },
      ],
    }, { kind: 'bug', steps: 'urgent outage' })).toBe(true)
  })

  test('filters stale hidden answers from submission payloads', () => {
    const answers = {
      consent: false,
      email: 'demo@example.com',
      kind: 'question',
      steps: 'stale secret answer',
    }

    expect(getVisibleRequestFieldIds(formVersion, answers)).toEqual([
      'email',
      'kind',
      'consent',
    ])
    expect(filterVisibleRequestAnswers(formVersion, answers)).toEqual({
      consent: false,
      email: 'demo@example.com',
      kind: 'question',
    })
  })

  test('does not let a stale hidden answer reveal a downstream field', () => {
    const chainedVersion: RequestFormLogicVersion = {
      defaultLocale: 'ja',
      locales: ['ja'],
      sections: [{
        id: 'chain',
        fields: [
          { id: 'trigger', type: 'text' },
          {
            condition: {
              match: 'all',
              rules: [{ fieldId: 'trigger', operator: 'equals', value: 'show' }],
            },
            id: 'hidden-source',
            type: 'text',
          },
          {
            condition: {
              match: 'all',
              rules: [{ fieldId: 'hidden-source', operator: 'equals', value: 'stale' }],
            },
            id: 'downstream',
            type: 'text',
          },
        ],
      }],
    }

    expect(getVisibleRequestFieldIds(chainedVersion, {
      'hidden-source': 'stale',
      trigger: 'hide',
    })).toEqual(['trigger'])
  })

  test('matches multi-select equals by scalar inclusion like the server', () => {
    expect(matchesRequestVisibilityCondition({
      match: 'all',
      rules: [{ fieldId: 'labels', operator: 'equals', value: 'urgent' }],
    }, { labels: ['urgent', 'external'] })).toBe(true)
    expect(matchesRequestVisibilityCondition({
      match: 'all',
      rules: [{ fieldId: 'labels', operator: 'not-equals', value: 'urgent' }],
    }, { labels: ['urgent', 'external'] })).toBe(false)
  })

  test('treats boolean false as a non-empty typed answer', () => {
    expect(matchesRequestVisibilityCondition({
      match: 'all',
      rules: [{ fieldId: 'approved', operator: 'is-not-empty' }],
    }, { approved: false })).toBe(true)
    expect(matchesRequestVisibilityCondition({
      match: 'all',
      rules: [{ fieldId: 'approved', operator: 'is-empty' }],
    }, { approved: false })).toBe(false)
  })

  test('selects only claims referenced by attachment fields', () => {
    const attachmentVersion: RequestFormLogicVersion = {
      defaultLocale: 'ja',
      locales: ['ja'],
      sections: [{
        id: 'files',
        fields: [
          { id: 'attachments', type: 'attachment' },
          { id: 'labels', type: 'multi-select' },
        ],
      }],
    }
    const claims = new Map([
      ['attachment-old-session', 'claim-token'],
      ['unselected-upload', 'unused-claim'],
      ['multi-select-value', 'not-an-attachment-claim'],
    ])

    expect(selectRequestAttachmentClaims(attachmentVersion, {
      attachments: ['attachment-old-session'],
      labels: ['multi-select-value'],
    }, claims)).toEqual({
      'attachment-old-session': 'claim-token',
    })
  })

  test('keeps every in-flight attachment field pending until its own upload completes', () => {
    let pendingFields: ReadonlySet<string> = new Set()

    pendingFields = updatePendingRequestAttachmentFields(pendingFields, 'evidence', true)
    pendingFields = updatePendingRequestAttachmentFields(pendingFields, 'logs', true)
    pendingFields = updatePendingRequestAttachmentFields(pendingFields, 'evidence', false)

    expect([...pendingFields]).toEqual(['logs'])
    expect(pendingFields.size).toBe(1)

    pendingFields = updatePendingRequestAttachmentFields(pendingFields, 'logs', false)
    expect(pendingFields.size).toBe(0)
  })

  test('limits each attachment selection by the remaining cumulative capacity', () => {
    expect(selectRemainingRequestAttachmentFiles(['new-1', 'new-2'], 2, 3)).toEqual([
      'new-1',
    ])
    expect(selectRemainingRequestAttachmentFiles(['new-1'], 3, 3)).toEqual([])
  })
})

describe('public request form response ownership', () => {
  test('rejects stale link and generation responses', () => {
    expect(isCurrentPublicRequestFormRequest('link-a', 2, 'link-a', 2)).toBe(true)
    expect(isCurrentPublicRequestFormRequest('link-a', 2, 'link-b', 2)).toBe(false)
    expect(isCurrentPublicRequestFormRequest('link-a', 1, 'link-a', 2)).toBe(false)
  })
})

describe('request form validation', () => {
  test('validates only visible fields with basic type rules', () => {
    expect(validateVisibleRequestAnswers(formVersion, {
      email: 'invalid',
      kind: 'bug',
      steps: 'short',
    })).toEqual([
      { fieldId: 'email', code: 'invalid-email' },
      { fieldId: 'steps', code: 'min-length' },
    ])

    expect(validateVisibleRequestAnswers(formVersion, {
      consent: false,
      email: 'demo@example.com',
      kind: 'question',
    })).toEqual([])
  })
})
