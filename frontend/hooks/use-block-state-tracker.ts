'use client'

import { useCallback, useState } from 'react'
import { useBlockchainSlowMotion } from '@/hooks/use-blockchain-slow-motion'
import { useEvents } from '@/hooks/use-events'
import { formatTimestamp } from '@/lib/timestamp'
import type { Block, BlockState } from '@/types/block'
import type { EventName, SerializableEventData } from '@/types/events'

const MAX_BLOCKS = 200
const BLOCK_STATE_EVENT_TYPES: readonly EventName[] = [
  'BlockStart',
  'BlockQC',
  'BlockFinalized',
  'BlockVerified',
  'BlockReject',
]

interface UseBlockStateTrackerReturn {
  blocks: Block[]
  isSlowMotion: boolean
  remainingSeconds: number
  startSlowMotion: () => void
  stopSlowMotion: () => void
  isFollowingChain: boolean
  setIsFollowingChain: (value: boolean) => void
}

// Map event types to block states
const EVENT_TO_STATE: Record<string, BlockState> = {
  BlockQC: 'voted',
  BlockFinalized: 'finalized',
  BlockVerified: 'verified',
}

/**
 * Applies a single event to a blocks array and returns the updated array.
 * Pure function with no side effects - used by both single event processing and batch flushing.
 */
function applyEventToBlocks(
  blocks: Block[],
  event: SerializableEventData,
): Block[] {
  const { payload } = event
  const timestamp = formatTimestamp(event.timestamp_ns)

  switch (payload.type) {
    case 'BlockStart': {
      const exists = blocks.some((b) => b.number === payload.block_number)
      if (exists) return blocks
      const newBlocks: Block[] = [
        ...blocks,
        { number: payload.block_number, state: 'proposed', timestamp },
      ]
      if (newBlocks.length > MAX_BLOCKS) {
        return newBlocks.slice(-Math.ceil(MAX_BLOCKS / 3))
      }
      return newBlocks
    }

    case 'BlockQC':
    case 'BlockFinalized':
    case 'BlockVerified': {
      const newState = EVENT_TO_STATE[payload.type]
      const index = blocks.findIndex((b) => b.number === payload.block_number)
      if (index === -1) return blocks
      const next = blocks.slice()
      next[index] = { ...blocks[index], state: newState, timestamp }
      return next
    }

    case 'BlockReject': {
      // BlockReject doesn't have block_number in payload, use event.block_number if available
      if (event.block_number !== undefined) {
        return blocks.filter((block) => block.number !== event.block_number)
      }
      return blocks
    }

    default:
      return blocks
  }
}

export function useBlockStateTracker(): UseBlockStateTrackerReturn {
  const [blocks, setBlocks] = useState<Block[]>([])
  const [isFollowingChain, setIsFollowingChain] = useState(true)

  // Process a single event and update blocks state
  const processEvent = useCallback((event: SerializableEventData) => {
    setBlocks((prev) => applyEventToBlocks(prev, event))
  }, [])

  // Flush all queued events at once when slow motion ends
  const flushEvents = useCallback((events: SerializableEventData[]) => {
    setBlocks((prev) => events.reduce(applyEventToBlocks, prev))
  }, [])

  const {
    isSlowMotion,
    remainingSeconds,
    startSlowMotion,
    stopSlowMotion,
    queueEvent,
  } = useBlockchainSlowMotion({
    onProcessEvent: processEvent,
    onFlushEvents: flushEvents,
  })

  useEvents({
    onEvent: queueEvent,
    eventTypes: BLOCK_STATE_EVENT_TYPES,
  })

  return {
    blocks,
    isSlowMotion,
    remainingSeconds,
    startSlowMotion,
    stopSlowMotion,
    isFollowingChain,
    setIsFollowingChain,
  }
}
