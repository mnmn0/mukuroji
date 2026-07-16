import type { AutomationInboundWebhookSecretResponse } from '@mukuroji/contracts'

/** React state にだけ保持する一回限りの Webhook secret です。 */
export type AutomationWebhookOneTimeSecret = {
  /** Secret を発行した endpoint ID です。 */
  endpointId: string
  /** Secret を発行した endpoint 表示名です。 */
  endpointName: string
  /** Create/rotate response から受け取った一回限りの secret です。 */
  signingSecret: string
}

/** One-time secret state の transition です。 */
export type AutomationWebhookSecretAction =
  | {
      /** Create/rotate response を表示する action です。 */
      type: 'reveal'
      /** Secret を含む一回限り response です。 */
      response: AutomationInboundWebhookSecretResponse
    }
  | {
      /** 利用者が secret を明示的に破棄する action です。 */
      type: 'dismiss'
    }
  | {
      /** Revoke 済み endpoint の secret を破棄する action です。 */
      type: 'revoke'
      /** Revoke した endpoint ID です。 */
      endpointId: string
    }

/** Create/rotate、dismiss、revoke に応じて one-time secret state を更新します。 */
export function reduceAutomationWebhookSecret(
  current: AutomationWebhookOneTimeSecret | undefined,
  action: AutomationWebhookSecretAction,
): AutomationWebhookOneTimeSecret | undefined {
  switch (action.type) {
    case 'reveal':
      return {
        endpointId: action.response.endpoint.id,
        endpointName: action.response.endpoint.name,
        signingSecret: action.response.signingSecret,
      }
    case 'dismiss':
      return undefined
    case 'revoke':
      return current?.endpointId === action.endpointId ? undefined : current
  }
}
