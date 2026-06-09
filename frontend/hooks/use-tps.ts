'use client'

import { useEffect, useState } from 'react'
import { useEventsContext } from '@/contexts/events-context'

/** Duration of TPS history to keep */
export const TPS_HISTORY_DURATION_MS = 5 * 60 * 1000

export interface TpsDataPoint {
  timestamp: number
  tps: number
}

export interface TpsData {
  currentTps: number
  peakTps: number
  history: TpsDataPoint[]
}

/**
 * Tracks TPS from backend metrics.
 */
export function useTps(): TpsData {
  const [tpsData, setTpsData] = useState<TpsData>({
    currentTps: 0,
    peakTps: 0,
    history: [],
  })

  const { subscribeToTps } = useEventsContext()

  useEffect(() => {
    const unsubscribe = subscribeToTps((tps) => {
      const now = Date.now()

      setTpsData((prev) => {
        const cutoffTime = now - TPS_HISTORY_DURATION_MS
        const filteredHistory = prev.history.filter((point) => {
          return point.timestamp >= cutoffTime
        })

        const nextHistory = [...filteredHistory, { timestamp: now, tps }]

        return {
          currentTps: tps,
          peakTps: Math.max(prev.peakTps, tps),
          history: nextHistory,
        }
      })
    })

    return unsubscribe
  }, [subscribeToTps])

  return tpsData
}
