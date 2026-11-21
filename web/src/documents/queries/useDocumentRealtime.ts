import { useEffect, useRef, useState } from 'react'
import {
  createDocumentRealtimeTicket,
  type DocumentChangePart,
} from '../api/realtime'
import { startDocumentRealtimeSubscription } from '../model/realtimeSubscription'

/** Inputs of the Document change-signal subscription. */
export type UseDocumentRealtimeInput = {
  /** Documents API access token; no subscription while undefined. */
  accessToken: string | undefined
  /** Open Document; no subscription while undefined. */
  documentId: string | undefined
  /** This editor's client ID, so its own changes are not read again. */
  clientId: string
  /** Called for each change made by someone else. */
  onChange: (part: DocumentChangePart) => void
}

/**
 * Subscribes to the open Document's change signals over WebSocket.
 *
 * When the deployment has no WebSocket, or the socket is down, `connected` is false so the
 * page keeps polling.
 *
 * @param input - Access token, Document, client ID, and change handler.
 * @returns Whether a subscription is currently open.
 */
export function useDocumentRealtime(input: UseDocumentRealtimeInput) {
  const { accessToken, clientId, documentId } = input
  const onChangeRef = useRef(input.onChange)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    onChangeRef.current = input.onChange
  }, [input.onChange])

  useEffect(() => {
    if (!accessToken || !documentId || typeof WebSocket === 'undefined') {
      return
    }
    const stop = startDocumentRealtimeSubscription({
      documentId,
      clientId,
      requestTicket: () => createDocumentRealtimeTicket(accessToken, documentId),
      createSocket: (url) => new WebSocket(url),
      onChange: (part) => onChangeRef.current(part),
      onConnectedChange: setConnected,
    })
    return () => {
      stop()
      setConnected(false)
    }
  }, [accessToken, clientId, documentId])

  return { connected }
}
