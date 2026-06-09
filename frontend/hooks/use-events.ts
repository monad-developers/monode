'use client'

import { useEffect, useRef } from 'react'
import { useEventsContext } from '@/contexts/events-context'
import type { EventName, SerializableEventData } from '@/types/events'

interface UseEventsOptions {
  onEvent?: (event: SerializableEventData) => void
  // Restrict delivery to these event types. Pass a stable reference (e.g. a
  // module-level constant) so the subscription isn't torn down on every render.
  eventTypes?: readonly EventName[]
}

/**
 * A hook that subscribes to events from the server.
 *
 * @example Basic usage
 * ```tsx
 * const { isConnected } = useEvents()
 * ```
 *
 * @example With event callback
 * ```tsx
 * const { isConnected } = useEvents({
 *   onEvent: (event) => console.log('New event:', event)
 * })
 * ```
 *
 * @example Restrict to specific event types
 * ```tsx
 * const EVENT_TYPES = ['TxnLog'] as const
 * useEvents({ onEvent: handleLog, eventTypes: EVENT_TYPES })
 * ```
 */
export function useEvents(options: UseEventsOptions = {}) {
  const { onEvent, eventTypes } = options
  const { accountAccesses, storageAccesses, isConnected, subscribe } =
    useEventsContext()
  const onEventRef = useRef(onEvent)

  useEffect(() => {
    onEventRef.current = onEvent
  }, [onEvent])

  useEffect(() => {
    if (!onEvent) {
      return
    }

    const unsubscribe = subscribe(
      (event) => {
        onEventRef.current?.(event)
      },
      eventTypes ? { eventTypes } : undefined,
    )

    return unsubscribe
  }, [onEvent, subscribe, eventTypes])

  return { accountAccesses, storageAccesses, isConnected }
}
