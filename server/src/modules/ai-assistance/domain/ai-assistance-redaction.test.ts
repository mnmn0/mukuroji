import { describe, expect, test } from 'bun:test'
import type { AiAssistanceDraft } from '@mukuroji/contracts'
import {
  aliasAiAssistanceTextIdentifiers,
  classifyAiAssistanceSensitivePromptField,
  redactAiAssistanceDraft,
  redactAiAssistancePromptFieldValue,
  redactAiAssistanceText,
} from './ai-assistance-redaction'

describe('AI assistance redaction', () => {
  test('aliases exact canonical member identifiers without substring replacement', () => {
    const result = aliasAiAssistanceTextIdentifiers(
      'owner@example.com xowner@example.com owner@example.com.au (owner@example.com)',
      [{ value: 'owner@example.com', alias: 'U1' }],
    )

    expect(result).toBe(
      'U1 xowner@example.com owner@example.com.au (U1)',
    )
  })

  test('redacts secret and identity canaries deterministically', () => {
    const input =
      'Bearer abc.def.ghi token=secret owner@example.com ' +
      '-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----'

    const first = redactAiAssistanceText(input)
    expect(redactAiAssistanceText(input)).toBe(first)
    expect(redactAiAssistanceText(first)).toBe(first)
    expect(first).not.toContain('abc.def.ghi')
    expect(first).not.toContain('secret')
    expect(first).not.toContain('owner@example.com')
    expect(first).not.toContain('BEGIN PRIVATE KEY')
  })

  test('redacts armored PGP private-key blocks', () => {
    const input = [
      '-----BEGIN PGP PRIVATE KEY BLOCK-----',
      'Version: test',
      '',
      'armored-private-material',
      '-----END PGP PRIVATE KEY BLOCK-----',
    ].join('\n')

    const redacted = redactAiAssistanceText(input)

    expect(redacted).toBe('[REDACTED_PRIVATE_KEY]')
    expect(redacted).not.toContain('armored-private-material')
    expect(redactAiAssistanceText(redacted)).toBe(redacted)
  })

  test('redacts authentication headers, cookies, sessions, JWTs, and URL userinfo', () => {
    const cases = [
      {
        input: 'Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==',
        expected: 'Authorization: [REDACTED_TOKEN]',
      },
      {
        input: 'Proxy-Authorization: Basic dXNlcjpwYXNz',
        expected: 'Proxy-Authorization: [REDACTED_TOKEN]',
      },
      {
        input: 'Authorization: AWS4-HMAC-SHA256 Credential=access/2026 Signature=secret',
        expected: 'Authorization: [REDACTED_TOKEN]',
      },
      {
        input: 'Proxy-Authorization: ApiKey opaque-secret; scope=private',
        expected: 'Proxy-Authorization: [REDACTED_TOKEN]',
      },
      {
        input: 'Authorization: opaque-secret',
        expected: 'Authorization: [REDACTED_TOKEN]',
      },
      {
        input: 'Cookie: session=opaque-session; theme=dark\nTrace: retained',
        expected: 'Cookie: [REDACTED_COOKIE]\nTrace: retained',
      },
      {
        input: 'Set-Cookie: connect.sid=opaque-session; HttpOnly; Secure',
        expected: 'Set-Cookie: [REDACTED_COOKIE]',
      },
      {
        input: 'Standalone eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.dGVzdC1zaWduYXR1cmU token.',
        expected: 'Standalone [REDACTED_JWT] token.',
      },
      {
        input: 'postgresql://app:s3cr%40t@db.example.test/work',
        expected: 'postgresql://[REDACTED_CREDENTIALS]@db.example.test/work',
      },
      {
        input: 'https://user@example.com:p@ssword@host.example.test/path',
        expected: 'https://[REDACTED_CREDENTIALS]@host.example.test/path',
      },
      {
        input: 'https://opaque-token@10.0.0.1/path',
        expected: 'https://[REDACTED_CREDENTIALS]@10.0.0.1/path',
      },
      {
        input: 'JSESSIONID=0123456789abcdef next-auth.session-token=opaque-session',
        expected: 'JSESSIONID=[REDACTED_SECRET] ' +
          'next-auth.session-token=[REDACTED_SECRET]',
      },
    ]

    for (const redactionCase of cases) {
      expect(redactAiAssistanceText(redactionCase.input)).toBe(redactionCase.expected)
    }
  })

  test('redacts presigned URL query credentials while retaining safe query context', () => {
    const input = [
      'https://bucket.s3.amazonaws.com/object.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256',
      'X-Amz-Credential=access%2F20260830%2Fap-northeast-1%2Fs3%2Faws4_request',
      'X-Amz-Security-Token=session-token&X-Amz-Signature=signature-value&keep=yes',
      'https://storage.googleapis.com/bucket/object?GoogleAccessId=service%40example.test',
      'X-Goog-Signature=google-signature&safe=1',
    ].join('&')

    const redacted = redactAiAssistanceText(input)

    expect(redacted).toContain('X-Amz-Credential=[REDACTED_PRESIGNED_URL]')
    expect(redacted).toContain('X-Amz-Security-Token=[REDACTED_PRESIGNED_URL]')
    expect(redacted).toContain('X-Amz-Signature=[REDACTED_PRESIGNED_URL]')
    expect(redacted).toContain('GoogleAccessId=[REDACTED_PRESIGNED_URL]')
    expect(redacted).toContain('X-Goog-Signature=[REDACTED_PRESIGNED_URL]')
    expect(redacted).toContain('keep=yes')
    expect(redacted).toContain('safe=1')
    expect(redacted).not.toContain('access%2F20260830')
    expect(redacted).not.toContain('signature-value')
    expect(redacted).not.toContain('google-signature')
    expect(redactAiAssistanceText(redacted)).toBe(redacted)
  })

  test('redacts known GitHub, Slack, and provider token prefixes', () => {
    // Assemble canaries at runtime so repository scanning does not mistake fixtures for live credentials.
    const tokens = [
      ['ghp_', '1234567890abcdefghijklmnopqrstuvwxyz'].join(''),
      ['github_pat_', '11AA22bb33CC44dd55EE66ff77GG88hh'].join(''),
      ['xoxb-', '123456789012-123456789012-abcdefghijklmnopqrstuvwx'].join(''),
      ['xapp-', '1-123456789012-123456789012-abcdefghijklmnopqrstuvwx'].join(''),
      ['sk-proj-', 'abcdefghijklmnopqrstuvwxyz0123456789'].join(''),
      ['sk-ant-api03-', 'abcdefghijklmnopqrstuvwxyz0123456789'].join(''),
      ['sk_', 'live_abcdefghijklmnopqrstuvwxyz012345'].join(''),
      ['gsk_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join(''),
      ['AIza', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789'].join(''),
      ['hf_', '1234567890abcdefghijklmnopqrstuvwxyz'].join(''),
    ]

    for (const token of tokens) {
      expect(redactAiAssistanceText(`credential ${token} retained`)).toBe(
        'credential [REDACTED_PREFIXED_TOKEN] retained',
      )
    }
  })

  test('redacts quoted credential assignments while retaining surrounding structure', () => {
    const input =
      '{"clientSecret": "open \\"sesame\\"", "sessionId":\'session-value\', ' +
      'connect.sid=opaque, token=query-secret&keep=yes}'

    expect(redactAiAssistanceText(input)).toBe(
      '{"clientSecret": "[REDACTED_SECRET]", "sessionId":\'[REDACTED_SECRET]\', ' +
      'connect.sid=[REDACTED_SECRET], token=[REDACTED_SECRET]&keep=yes}',
    )
  })

  test('redacts labeled people, phone numbers, and postal addresses deterministically', () => {
    const input = [
      '氏名: 山田 太郎',
      '電話: 090-1234-5678',
      '住所: 東京都千代田区丸の内1-1-1',
      'Backup +1 415 555 2671 at 123 Main Street, Springfield',
    ].join('\n')

    const first = redactAiAssistanceText(input)

    expect(redactAiAssistanceText(first)).toBe(first)
    expect(first).not.toContain('山田 太郎')
    expect(first).not.toContain('090-1234-5678')
    expect(first).not.toContain('東京都千代田区丸の内1-1-1')
    expect(first).not.toContain('415 555 2671')
    expect(first).not.toContain('123 Main Street')
    expect(first).toContain('[REDACTED_PERSON]')
    expect(first).toContain('[REDACTED_PHONE]')
    expect(first).toContain('[REDACTED_ADDRESS]')

    const unlabeled = redactAiAssistanceText(
      '佐藤 花子 090-1234-5678 東京都千代田区丸の内1-1-1',
    )
    expect(unlabeled).not.toContain('佐藤 花子')
    expect(unlabeled).not.toContain('090-1234-5678')
    expect(unlabeled).not.toContain('東京都千代田区')
  })

  test('uses Request field metadata without discarding benign free-form context', () => {
    expect(redactAiAssistancePromptFieldValue({
      fieldId: 'requester-name',
      label: 'お名前',
      fieldType: 'short-text',
      value: '山田 太郎',
    })).toBe('[REDACTED_PERSON]')
    expect(redactAiAssistancePromptFieldValue({
      fieldId: 'phone',
      label: 'Phone number',
      fieldType: 'short-text',
      value: '09012345678',
    })).toBe('[REDACTED_PHONE]')
    expect(redactAiAssistancePromptFieldValue({
      fieldId: 'field-telephone',
      label: 'Phone number (required)',
      fieldType: 'number',
      value: 9_012_345_678,
    })).toBe('[REDACTED_PHONE]')
    expect(redactAiAssistancePromptFieldValue({
      fieldId: 'customer-phone',
      label: 'Customer phone',
      fieldType: 'number',
      value: 9_012_345_678,
    })).toBe('[REDACTED_PHONE]')
    expect(redactAiAssistancePromptFieldValue({
      fieldId: 'customerPhone',
      label: 'Contact value',
      fieldType: 'number',
      value: 9_012_345_678,
    })).toBe('[REDACTED_PHONE]')
    expect(redactAiAssistancePromptFieldValue({
      fieldId: 'contactAddress',
      label: 'Contact value',
      fieldType: 'short-text',
      value: '123 Main Street',
    })).toBe('[REDACTED_ADDRESS]')
    expect(redactAiAssistancePromptFieldValue({
      fieldId: 'customer-phone',
      label: 'Customer phone',
      fieldType: 'structured',
      value: { raw: 9_012_345_678 },
    })).toBe('[REDACTED_PHONE]')
    expect(redactAiAssistancePromptFieldValue({
      fieldId: 'contact-names',
      label: 'Contacts',
      fieldType: 'person',
      value: ['Alex Smith', 'Jamie Jones'],
    })).toEqual(['[REDACTED_PERSON]', '[REDACTED_PERSON]'])
    expect(redactAiAssistancePromptFieldValue({
      fieldId: 'address',
      label: '送付先住所',
      fieldType: 'long-text',
      value: '東京都千代田区丸の内1-1-1',
    })).toBe('[REDACTED_ADDRESS]')
    expect(redactAiAssistancePromptFieldValue({
      fieldId: 'email',
      label: '返信先',
      fieldType: 'email',
      value: 'requester@example.com',
    })).toBe('[REDACTED_EMAIL]')
    expect(redactAiAssistancePromptFieldValue({
      fieldId: 'customer-e-mail',
      label: 'Customer e-mail address',
      fieldType: 'short-text',
      value: 'requester@example.com',
    })).toBe('[REDACTED_EMAIL]')
    expect(redactAiAssistancePromptFieldValue({
      fieldId: 'project-name',
      label: 'Project name (required)',
      fieldType: 'short-text',
      value: 'Atlas migration',
    })).toBe('Atlas migration')
    expect(redactAiAssistancePromptFieldValue({
      fieldId: 'field-1',
      label: 'Full name (required)',
      fieldType: 'short-text',
      value: 'Alex Smith',
    })).toBe('[REDACTED_PERSON]')
    expect(redactAiAssistancePromptFieldValue({
      fieldId: 'field-2',
      label: 'Optional: Contact name *',
      fieldType: 'short-text',
      value: 'Jamie Jones',
    })).toBe('[REDACTED_PERSON]')
    expect(redactAiAssistancePromptFieldValue({
      fieldId: 'opaque-surname-field',
      label: '姓（必須）',
      fieldType: 'short-text',
      value: '山田',
    })).toBe('[REDACTED_PERSON]')
    expect(redactAiAssistancePromptFieldValue({
      fieldId: 'opaque-given-name-field',
      label: '名',
      fieldType: 'short-text',
      value: '太郎',
    })).toBe('[REDACTED_PERSON]')
    expect(redactAiAssistancePromptFieldValue({
      fieldId: '姓',
      label: 'Field',
      fieldType: 'short-text',
      value: '山田',
    })).toBe('[REDACTED_PERSON]')
    expect(redactAiAssistancePromptFieldValue({
      fieldId: '名',
      label: 'Field',
      fieldType: 'short-text',
      value: '太郎',
    })).toBe('[REDACTED_PERSON]')
    expect(redactAiAssistancePromptFieldValue({
      fieldId: 'project-name',
      label: '名称',
      fieldType: 'short-text',
      value: 'Atlas migration',
    })).toBe('Atlas migration')
    for (const label of ['firstName', 'lastName', 'givenName', 'surname']) {
      expect(redactAiAssistancePromptFieldValue({
        fieldId: `request-${label}`,
        label,
        fieldType: 'short-text',
        value: 'Alex Smith',
      })).toBe('[REDACTED_PERSON]')
    }
    expect(redactAiAssistancePromptFieldValue({
      fieldId: 'feature-name',
      label: 'Feature name (optional)',
      fieldType: 'short-text',
      value: 'Private preview',
    })).toBe('Private preview')
    expect(redactAiAssistancePromptFieldValue({
      fieldId: 'annual-volume',
      label: 'Annual request volume',
      fieldType: 'number',
      value: 9_012_345_678,
    })).toBe(9_012_345_678)
    expect(redactAiAssistancePromptFieldValue({
      fieldId: 'project-budget',
      label: 'Project budget',
      fieldType: 'number',
      value: 9_012_345_678,
    })).toBe(9_012_345_678)
    expect(redactAiAssistancePromptFieldValue({
      fieldId: 'details',
      label: 'Details',
      fieldType: 'long-text',
      value: 'Keep rollout context; token=hidden-value',
    })).toBe('Keep rollout context; token=[REDACTED_SECRET]')
  })

  test('classifies custom field metadata without value-based business false positives', () => {
    expect(classifyAiAssistanceSensitivePromptField({
      fieldId: 'customer-phone',
      label: 'Customer phone',
      fieldType: 'number',
    })).toBe('[REDACTED_PHONE]')
    expect(classifyAiAssistanceSensitivePromptField({
      fieldId: 'contact-names',
      label: 'Contacts',
      fieldType: 'person',
    })).toBe('[REDACTED_PERSON]')
    expect(classifyAiAssistanceSensitivePromptField({
      fieldId: 'customer-email',
      label: 'Customer e-mail',
      fieldType: 'text',
    })).toBe('[REDACTED_EMAIL]')
    expect(classifyAiAssistanceSensitivePromptField({
      fieldId: 'project-budget',
      label: 'Project budget',
      fieldType: 'number',
    })).toBeUndefined()
    expect(classifyAiAssistanceSensitivePromptField({
      fieldId: 'project-name',
      label: 'Project name (required)',
      fieldType: 'text',
    })).toBeUndefined()
  })

  test('replaces every model-owned Summary and Planning row identifier', () => {
    const summary: AiAssistanceDraft = {
      kind: 'summary',
      overview: {
        id: 'victim@example.com',
        text: 'Overview.',
        confidence: 'high',
        citationIds: ['source-1'],
      },
      decisions: [{
        id: 'Bearer leaked-decision-token',
        text: 'Decision.',
        confidence: 'medium',
        citationIds: ['source-1'],
      }],
      actions: [{
        id: 'duplicate-model-id',
        text: 'Action.',
        confidence: 'medium',
        citationIds: ['source-1'],
      }],
      risks: [{
        id: 'duplicate-model-id',
        text: 'Risk.',
        confidence: 'low',
        citationIds: ['source-1'],
      }],
    }
    const planning: AiAssistanceDraft = {
      kind: 'planning',
      subtasks: [0, 1].map((index) => ({
        id: 'person@example.com',
        title: `Subtask ${index + 1}`,
        priority: 'medium',
        reason: 'Needed.',
        confidence: 'medium',
        citationIds: ['source-1'],
      })),
      dependencies: [0, 1].map(() => ({
        id: 'token=dependency-secret',
        predecessor: { teamId: 'team-1', workItemId: 'work-item-1' },
        successor: { teamId: 'team-1', workItemId: 'work-item-2' },
        type: 'finish-to-start',
        lagDays: 0,
        reason: 'Required.',
        confidence: 'high',
        citationIds: ['source-1'],
      })),
    }

    const safeSummary = redactAiAssistanceDraft(summary)
    const safePlanning = redactAiAssistanceDraft(planning)

    expect(safeSummary.kind).toBe('summary')
    expect(safeSummary).toMatchObject({
      overview: { id: 'summary-overview-1' },
      decisions: [{ id: 'summary-decision-1' }],
      actions: [{ id: 'summary-action-1' }],
      risks: [{ id: 'summary-risk-1' }],
    })
    expect(safePlanning.kind).toBe('planning')
    expect(safePlanning).toMatchObject({
      subtasks: [
        { id: 'planning-subtask-1' },
        { id: 'planning-subtask-2' },
      ],
      dependencies: [
        { id: 'planning-dependency-1' },
        { id: 'planning-dependency-2' },
      ],
    })
    const serialized = JSON.stringify({ safeSummary, safePlanning })
    expect(serialized).not.toContain('victim@example.com')
    expect(serialized).not.toContain('person@example.com')
    expect(serialized).not.toContain('dependency-secret')
    expect(serialized).not.toContain('duplicate-model-id')
  })

  test('preserves prose and identifiers that only resemble credential vocabulary', () => {
    const input =
      'Authorization uses Basic authentication. Keep cookie preferences in the browser ' +
      'session plan at https://example.com/users/alice. xoxb-description ' +
      'github_pattern sketch-project eyJ.short.parts. Release 1.20.300 on 2026-08-25. ' +
      '新規 機能 and 東京 大阪 are business terms.'

    expect(redactAiAssistanceText(input)).toBe(input)
  })
})
