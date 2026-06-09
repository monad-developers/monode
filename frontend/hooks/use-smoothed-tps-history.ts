'use client'

import { useEffect, useRef, useState } from 'react'
import type { TpsDataPoint } from '@/hooks/use-tps'

/**
 * Matches the backend's TPS cadence (~one update per block at ~400ms).
 * Picking the inter-arrival time lets the tween finish right as the next
 * datapoint arrives, producing continuous motion instead of a snap.
 */
const ANIMATION_DURATION_MS = 400

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3
}

interface AnimationState {
  startTime: number
  startValue: number
  startTimestamp: number
  targetValue: number
  targetTimestamp: number
}

function pointAt(anim: AnimationState, now: number): TpsDataPoint {
  const t = Math.min(1, (now - anim.startTime) / ANIMATION_DURATION_MS)
  const eased = easeOutCubic(t)
  return {
    tps: anim.startValue + (anim.targetValue - anim.startValue) * eased,
    timestamp:
      anim.startTimestamp +
      (anim.targetTimestamp - anim.startTimestamp) * eased,
  }
}

/**
 * Tweens the trailing tip of a TPS history so the chart extends smoothly to
 * each new datapoint rather than snapping. When a new point arrives mid-tween,
 * the tween restarts from the current interpolated position so the line never
 * jumps.
 */
export function useSmoothedTpsHistory(history: TpsDataPoint[]): TpsDataPoint[] {
  const [rendered, setRendered] = useState<TpsDataPoint[]>(history)
  const animRef = useRef<AnimationState | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (history.length === 0) {
      animRef.current = null
      setRendered([])
      return
    }

    const latest = history[history.length - 1]

    if (
      animRef.current !== null &&
      animRef.current.targetTimestamp === latest.timestamp
    ) {
      return
    }

    const prev = history[history.length - 2]
    const now = performance.now()
    const tip: TpsDataPoint =
      animRef.current !== null
        ? pointAt(animRef.current, now)
        : {
            tps: prev?.tps ?? latest.tps,
            timestamp: prev?.timestamp ?? latest.timestamp,
          }

    animRef.current = {
      startTime: now,
      startValue: tip.tps,
      startTimestamp: tip.timestamp,
      targetValue: latest.tps,
      targetTimestamp: latest.timestamp,
    }

    const head = history.slice(0, -1)

    const tick = () => {
      const anim = animRef.current
      if (anim === null) return
      const current = pointAt(anim, performance.now())
      setRendered([...head, current])
      if (performance.now() - anim.startTime < ANIMATION_DURATION_MS) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        rafRef.current = null
      }
    }

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(tick)
  }, [history])

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  return rendered
}
