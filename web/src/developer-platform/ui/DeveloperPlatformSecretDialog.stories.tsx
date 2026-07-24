import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import {
  developerPlatformLabelsFixture,
  issuedApiKeySecretFixture,
  issuedOAuthClientSecretFixture,
  issuedWebhookSigningSecretFixture,
} from '../fixtures'
import {
  SecretDialog,
  type SecretDialogState,
} from './DeveloperPlatformSecretDialog'
import type { SecretDialogKind } from './DeveloperPlatformView'

/**
 * Controls the one-time secret dialog rendered by the Storybook preview.
 */
type DeveloperPlatformSecretDialogPreviewProps = {
  /** Optional clipboard error displayed by the dialog. */
  copyErrorMessage?: string
  /** Whether storage confirmation starts selected. */
  initiallyStored?: boolean
  /** Secret kind displayed by the preview. */
  kind?: SecretDialogKind
}

/**
 * Creates the one-time secret state for a Storybook dialog kind.
 *
 * @param kind - Credential kind displayed by the secret dialog.
 * @returns The matching fixture-backed secret dialog state.
 */
function createSecretDialogState(kind: SecretDialogKind): SecretDialogState {
  if (kind === 'api-key') {
    return {
      kind,
      name: issuedApiKeySecretFixture.apiKey.name,
      value: issuedApiKeySecretFixture.secret,
    }
  }

  if (kind === 'oauth-app') {
    return {
      kind,
      name: issuedOAuthClientSecretFixture.oauthApp.name,
      value: issuedOAuthClientSecretFixture.clientSecret,
    }
  }

  return {
    kind,
    name: issuedWebhookSigningSecretFixture.subscription.name,
    value: issuedWebhookSigningSecretFixture.signingSecret,
  }
}

/**
 * Renders a controlled one-time secret dialog for Storybook.
 *
 * @param props - Dialog kind, copy error, and initial storage confirmation.
 * @returns The controlled secret dialog preview.
 */
function DeveloperPlatformSecretDialogPreview(
  props: DeveloperPlatformSecretDialogPreviewProps,
) {
  const kind = props.kind ?? 'api-key'
  const [copied, setCopied] = useState(false)
  const [stored, setStored] = useState(props.initiallyStored ?? false)

  return (
    <SecretDialog
      copied={copied}
      copyErrorMessage={props.copyErrorMessage}
      labels={developerPlatformLabelsFixture}
      state={createSecretDialogState(kind)}
      stored={stored}
      onCopy={() => {
        if (!props.copyErrorMessage) {
          setCopied(true)
        }
        return Promise.resolve()
      }}
      onRequestClose={() => undefined}
      onStoredChange={setStored}
    />
  )
}

/**
 * Storybook metadata for the Developer Platform one-time secret dialog.
 */
const meta = {
  title: 'Application/Developer Platform/Secret Dialog',
  component: DeveloperPlatformSecretDialogPreview,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    kind: 'api-key',
    initiallyStored: false,
  },
} satisfies Meta<typeof DeveloperPlatformSecretDialogPreview>

export default meta

/**
 * Story type for Developer Platform one-time secret dialog previews.
 */
type Story = StoryObj<typeof meta>

/**
 * Shows an API key secret before storage is confirmed.
 */
export const ApiKey: Story = {}

/**
 * Shows an OAuth client secret before storage is confirmed.
 */
export const OAuthApplication: Story = {
  args: {
    kind: 'oauth-app',
  },
}

/**
 * Shows a webhook signing secret before storage is confirmed.
 */
export const Webhook: Story = {
  args: {
    kind: 'webhook',
  },
}

/**
 * Shows the safe error message displayed when clipboard access fails.
 */
export const CopyError: Story = {
  args: {
    copyErrorMessage: developerPlatformLabelsFixture.helpText.secretCopyError,
  },
}

/**
 * Shows a stored secret with the close action enabled.
 */
export const Stored: Story = {
  args: {
    initiallyStored: true,
  },
}
