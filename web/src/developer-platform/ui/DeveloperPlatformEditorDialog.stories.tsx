import type { ApiScope } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import type { DeveloperOAuthGrantType } from '../model/credentials'
import type { DeveloperWebhookEventType } from '../model/webhooks'
import { developerPlatformLabelsFixture } from '../fixtures'
import { EditorDialog } from './DeveloperPlatformEditorDialog'
import type { EditorDialogKind } from './DeveloperPlatformView'

const webhookTeamOptions = [
  {
    value: 'team-product',
    label: 'Product',
    description: 'Product engineering Team.',
  },
]

/**
 * Controls the editor dialog variant rendered by the Storybook preview.
 */
type DeveloperPlatformEditorDialogPreviewProps = {
  /** Editor kind displayed by the preview. */
  kind?: EditorDialogKind
  /** Whether required selections start empty. */
  requiredSelectionError?: boolean
}

/**
 * Renders a controlled Developer Platform editor dialog for Storybook.
 *
 * @param props - Dialog kind and whether required selections start empty.
 * @returns The controlled editor dialog preview.
 */
function DeveloperPlatformEditorDialogPreview(
  props: DeveloperPlatformEditorDialogPreviewProps,
) {
  const kind = props.kind ?? 'api-key'
  const requiredSelectionError = props.requiredSelectionError ?? false
  const [apiKeyExpiry, setApiKeyExpiry] = useState('2026-12-31')
  const [apiKeyName, setApiKeyName] = useState('Story automation')
  const [apiKeyScopes, setApiKeyScopes] = useState<ApiScope[]>(
    requiredSelectionError && kind === 'api-key' ? [] : ['work-items:read'],
  )
  const [oauthExpiry, setOAuthExpiry] = useState('2026-12-31')
  const [oauthGrantTypes, setOAuthGrantTypes] = useState<
    DeveloperOAuthGrantType[]
  >(['client_credentials'])
  const [oauthName, setOAuthName] = useState('Story OAuth app')
  const [oauthScopes, setOAuthScopes] = useState<ApiScope[]>(
    requiredSelectionError && kind === 'oauth-app' ? [] : ['work-items:read'],
  )
  const [webhookEvents, setWebhookEvents] = useState<
    DeveloperWebhookEventType[]
  >(requiredSelectionError && kind === 'webhook' ? [] : ['work-item.updated'])
  const [webhookName, setWebhookName] = useState('Story webhook')
  const [webhookScopes, setWebhookScopes] = useState<ApiScope[]>(
    requiredSelectionError && kind === 'webhook' ? [] : ['work-items:read'],
  )
  const [webhookTeamIds, setWebhookTeamIds] = useState<string[]>(
    requiredSelectionError && kind === 'webhook' ? [] : ['team-product'],
  )
  const [webhookUrl, setWebhookUrl] = useState(
    'https://example.com/webhooks/mukuroji',
  )

  return (
    <EditorDialog
      apiKeyExpiry={apiKeyExpiry}
      apiKeyName={apiKeyName}
      apiKeyScopes={apiKeyScopes}
      kind={kind}
      labels={developerPlatformLabelsFixture}
      oauthExpiry={oauthExpiry}
      oauthGrantTypes={oauthGrantTypes}
      oauthName={oauthName}
      oauthScopes={oauthScopes}
      webhookEvents={webhookEvents}
      webhookName={webhookName}
      webhookScopes={webhookScopes}
      webhookTeamIds={webhookTeamIds}
      webhookTeamOptions={webhookTeamOptions}
      webhookUrl={webhookUrl}
      onApiKeyExpiryChange={setApiKeyExpiry}
      onApiKeyNameChange={setApiKeyName}
      onApiKeyScopesChange={setApiKeyScopes}
      onOAuthExpiryChange={setOAuthExpiry}
      onOAuthGrantTypesChange={setOAuthGrantTypes}
      onOAuthNameChange={setOAuthName}
      onOAuthScopesChange={setOAuthScopes}
      onRequestClose={() => undefined}
      onSubmitApiKey={(event) => event.preventDefault()}
      onSubmitOAuthApp={(event) => event.preventDefault()}
      onSubmitWebhook={(event) => event.preventDefault()}
      onWebhookEventsChange={setWebhookEvents}
      onWebhookNameChange={setWebhookName}
      onWebhookScopesChange={setWebhookScopes}
      onWebhookTeamIdsChange={setWebhookTeamIds}
      onWebhookUrlChange={setWebhookUrl}
    />
  )
}

/**
 * Storybook metadata for the Developer Platform editor dialog.
 */
const meta = {
  title: 'Application/Developer Platform/Editor Dialog',
  component: DeveloperPlatformEditorDialogPreview,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    kind: 'api-key',
    requiredSelectionError: false,
  },
} satisfies Meta<typeof DeveloperPlatformEditorDialogPreview>

export default meta

/**
 * Story type for Developer Platform editor dialog previews.
 */
type Story = StoryObj<typeof meta>

/**
 * Shows the API key creation form with a selected scope.
 */
export const ApiKey: Story = {}

/**
 * Shows the OAuth application creation form.
 */
export const OAuthApplication: Story = {
  args: {
    kind: 'oauth-app',
  },
}

/**
 * Shows the webhook subscription creation form.
 */
export const Webhook: Story = {
  args: {
    kind: 'webhook',
  },
}

/**
 * Shows required-selection errors with the submit action disabled.
 */
export const RequiredSelectionError: Story = {
  args: {
    kind: 'webhook',
    requiredSelectionError: true,
  },
}
