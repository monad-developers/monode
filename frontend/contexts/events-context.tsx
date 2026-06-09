'use client'

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { EventName, SerializableEventData } from '@/types/events'

interface AccessEntry<T> {
  key: T
  count: number
}

interface TopAccessesData {
  account: AccessEntry<string>[]
  storage: AccessEntry<[string, string]>[]
}

interface ServerMessage {
  Events?: SerializableEventData[]
  TopAccesses?: TopAccessesData
  TPS?: number
}

export interface SubscribeOptions {
  // Restrict delivery to these event types. Omit to receive all events.
  eventTypes?: readonly EventName[]
}

interface EventsContextValue {
  accountAccesses: AccessEntry<string>[]
  storageAccesses: AccessEntry<[string, string]>[]
  isConnected: boolean
  subscribe: (
    callback: (event: SerializableEventData) => void,
    options?: SubscribeOptions,
  ) => () => void
  subscribeToTps: (callback: (tps: number) => void) => () => void
}

interface EventsProviderProps {
  children: ReactNode
}

interface Subscriber {
  callback: (event: SerializableEventData) => void
  eventTypes: ReadonlySet<EventName> | null
}

const EventsContext = createContext<EventsContextValue | null>(null)

const RECONNECT_DELAY = 3000

/**
 * A context provider for the events context.
 * It handles the WebSocket connection and receives events from the server.
 * The server uses restricted filters to determine which events to send.
 */
export function EventsProvider({ children }: EventsProviderProps) {
  const [accountAccesses, setAccountAccesses] = useState<AccessEntry<string>[]>(
    [],
  )
  const [storageAccesses, setStorageAccesses] = useState<
    AccessEntry<[string, string]>[]
  >([])
  const [isConnected, setIsConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const subscribersRef = useRef<Map<string, Subscriber>>(new Map())
  const tpsSubscribersRef = useRef<Map<string, (tps: number) => void>>(
    new Map(),
  )

  useEffect(() => {
    let ws: WebSocket | null = null
    let reconnectTimeout: NodeJS.Timeout | null = null

    const connect = () => {
      try {
        const url = process.env.NEXT_PUBLIC_EVENTS_WS_URL

        if (!url) {
          throw new Error('NEXT_PUBLIC_EVENTS_WS_URL is not set')
        }

        ws = new WebSocket(url)
        wsRef.current = ws

        ws.onopen = () => {
          setIsConnected(true)
        }

        ws.onmessage = (event) => {
          // Browsers don't throttle WebSocket onmessage in background tabs, but
          // the heavy downstream work (setState fan-out, viem.decodeEventLog)
          // still allocates aggressively. Dropping messages while hidden keeps
          // the JS heap from blowing up during long backgrounded sessions.
          if (
            typeof document !== 'undefined' &&
            document.visibilityState === 'hidden'
          ) {
            return
          }

          try {
            const message: ServerMessage = JSON.parse(event.data)

            if (message.TopAccesses) {
              setAccountAccesses(message.TopAccesses.account)
              setStorageAccesses(message.TopAccesses.storage)
            }

            if (typeof message.TPS === 'number') {
              const tps = message.TPS
              tpsSubscribersRef.current.forEach((callback) => {
                callback(tps)
              })
            }

            if (message.Events && message.Events.length > 0) {
              const newEvents = message.Events
              const subscribers = subscribersRef.current

              for (const evt of newEvents) {
                const eventType = evt.payload.type as EventName
                subscribers.forEach((sub) => {
                  if (
                    sub.eventTypes === null ||
                    sub.eventTypes.has(eventType)
                  ) {
                    sub.callback(evt)
                  }
                })
              }
            }
          } catch (error) {
            console.error('Failed to parse message:', error)
          }
        }

        ws.onerror = (error) => {
          console.error('WebSocket error:', error)
        }

        ws.onclose = () => {
          setIsConnected(false)
          wsRef.current = null

          reconnectTimeout = setTimeout(() => {
            connect()
          }, RECONNECT_DELAY)
        }
      } catch (error) {
        console.error('Failed to connect:', error)
        reconnectTimeout = setTimeout(() => {
          connect()
        }, RECONNECT_DELAY)
      }
    }

    connect()

    return () => {
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout)
      }
      if (ws) {
        ws.close()
      }
    }
  }, [])

  const subscribe = useCallback(
    (
      callback: (event: SerializableEventData) => void,
      options?: SubscribeOptions,
    ): (() => void) => {
      const subscriberId = Math.random().toString(36).slice(2)
      const eventTypes =
        options?.eventTypes && options.eventTypes.length > 0
          ? new Set(options.eventTypes)
          : null
      subscribersRef.current.set(subscriberId, { callback, eventTypes })

      return () => {
        subscribersRef.current.delete(subscriberId)
      }
    },
    [],
  )

  const subscribeToTps = useCallback((callback: (tps: number) => void) => {
    const subscriberId = Math.random().toString(36).slice(2)
    tpsSubscribersRef.current.set(subscriberId, callback)

    return () => {
      tpsSubscribersRef.current.delete(subscriberId)
    }
  }, [])

  // Without memoization, every TopAccesses update re-renders every consumer of
  // useEventsContext, even ones that only need subscribe/subscribeToTps.
  const value = useMemo<EventsContextValue>(
    () => ({
      accountAccesses,
      storageAccesses,
      isConnected,
      subscribe,
      subscribeToTps,
    }),
    [accountAccesses, storageAccesses, isConnected, subscribe, subscribeToTps],
  )

  return (
    <EventsContext.Provider value={value}>{children}</EventsContext.Provider>
  )
}

export function useEventsContext() {
  const context = useContext(EventsContext)
  if (!context) {
    throw new Error('useEventsContext must be used within EventsProvider')
  }
  return context
}
