import { useCallback, useMemo, useRef, useState } from 'react'
import {
  fromNsToMsPrecise,
  getBlockWallTimeMs,
  getTotalTransactionTimeMs,
} from '@/lib/block-metrics'
import type { Block, BlockState } from '@/types/block'
import type { EventName, SerializableEventData } from '@/types/events'
import type { Transaction } from '@/types/transaction'
import { useEvents } from './use-events'

const MAX_BLOCKS = 200
const MAX_INFLIGHT_BLOCKS = MAX_BLOCKS

// Highlight when total tx execution time exceeds block execution time.
// Keep this as a single constant so UI/copy can stay consistent.
export const PARALLEL_EXECUTION_RATIO_THRESHOLD = 1

const EXECUTION_EVENT_TYPES: readonly EventName[] = [
  'BlockStart',
  'TxnHeaderStart',
  'TxnEnd',
  'TxnEvmOutput',
  'BlockEnd',
  'BlockQC',
  'BlockFinalized',
  'BlockVerified',
]

interface InflightBlock {
  block: Omit<Block, 'transactions'>
  // Keyed by txnIndex so per-event updates are O(1) instead of O(N).
  transactions: Map<number, Transaction>
}

/**
 * Build the immutable Block snapshot that gets pushed into React state.
 */
function freezeInflightBlock(entry: InflightBlock, state: BlockState): Block {
  const txs = Array.from(entry.transactions.values()).sort(
    (a, b) => a.txnIndex - b.txnIndex,
  )
  return {
    ...entry.block,
    state,
    transactions: txs,
  }
}

/**
 * Hook to track block execution events and derive timing metrics.
 *
 * In-flight blocks (and their transactions) live in refs and are mutated in
 * place as events arrive. Only when a block finalizes do we materialize it
 * into React state, which avoids the O(N²) array allocations the previous
 * implementation did on every txn event during a block.
 */
export function useBlockExecutionTracker() {
  const [finalizedBlocks, setFinalizedBlocks] = useState<Block[]>([])
  const inflightRef = useRef<Map<number, InflightBlock>>(new Map())
  const currentBlockNumberRef = useRef<number | null>(null)

  const updateFinalizedState = useCallback(
    (blockNumber: number, state: BlockState) => {
      setFinalizedBlocks((prev) => {
        const index = prev.findIndex((b) => b.number === blockNumber)
        if (index === -1) return prev
        if (prev[index].state === state) return prev
        const next = prev.slice()
        next[index] = { ...prev[index], state }
        return next
      })
    },
    [],
  )

  const promoteInflightToFinalized = useCallback(
    (blockNumber: number, state: BlockState) => {
      const entry = inflightRef.current.get(blockNumber)
      if (!entry) {
        updateFinalizedState(blockNumber, state)
        return
      }
      inflightRef.current.delete(blockNumber)
      if (currentBlockNumberRef.current === blockNumber) {
        currentBlockNumberRef.current = null
      }
      const frozen = freezeInflightBlock(entry, state)
      setFinalizedBlocks((prev) => {
        const next = [...prev, frozen]
        if (next.length > MAX_BLOCKS) {
          return next.slice(-Math.ceil(MAX_BLOCKS / 3))
        }
        return next
      })
    },
    [updateFinalizedState],
  )

  const handleEvent = useCallback(
    (event: SerializableEventData) => {
      switch (event.payload.type) {
        case 'BlockStart': {
          const payload = event.payload
          const blockNumber = event.block_number || payload.block_number
          if (blockNumber === undefined) {
            console.warn('BlockStart event missing block_number:', event)
            return
          }
          const existing = inflightRef.current.get(blockNumber)
          if (existing && existing.block.id === payload.block_id) {
            // Duplicate BlockStart for the same block id — refresh timing.
            existing.block.state = 'proposed'
            existing.block.startTimestamp = BigInt(event.timestamp_ns)
            currentBlockNumberRef.current = blockNumber
            return
          }
          inflightRef.current.set(blockNumber, {
            block: {
              id: payload.block_id,
              number: blockNumber,
              state: 'proposed',
              startTimestamp: BigInt(event.timestamp_ns),
            },
            transactions: new Map(),
          })
          currentBlockNumberRef.current = blockNumber

          // Defensive cap in case finalization events never arrive for some
          // blocks — without this the inflight map could grow without bound.
          if (inflightRef.current.size > MAX_INFLIGHT_BLOCKS) {
            const oldest = Math.min(...inflightRef.current.keys())
            inflightRef.current.delete(oldest)
          }
          return
        }

        case 'TxnHeaderStart': {
          const payload = event.payload
          const blockNumber = currentBlockNumberRef.current
          if (blockNumber === null) {
            console.warn(
              'TxnHeaderStart event received but no inflight block:',
              event,
            )
            return
          }
          const entry = inflightRef.current.get(blockNumber)
          if (!entry) return
          entry.transactions.set(payload.txn_index, {
            id: payload.txn_index,
            txnIndex: payload.txn_index,
            txnHash: payload.txn_hash,
            startTimestamp: BigInt(event.timestamp_ns),
            transactionTime: undefined,
            gasLimit: payload.gas_limit,
            sender: payload.sender,
            to: payload.to,
          })
          return
        }

        case 'TxnEnd': {
          if (event.txn_idx === undefined) {
            console.warn('TxnEnd event missing txn_idx:', event)
            return
          }
          const blockNumber = currentBlockNumberRef.current
          if (blockNumber === null) return
          const entry = inflightRef.current.get(blockNumber)
          if (!entry) return
          const tx = entry.transactions.get(event.txn_idx)
          if (!tx || tx.startTimestamp === undefined) return
          const endTs = BigInt(event.timestamp_ns)
          tx.endTimestamp = endTs
          tx.transactionTime = endTs - tx.startTimestamp
          return
        }

        case 'TxnEvmOutput': {
          const payload = event.payload
          const blockNumber = currentBlockNumberRef.current
          if (blockNumber === null) return
          const entry = inflightRef.current.get(blockNumber)
          if (!entry) return
          const tx = entry.transactions.get(payload.txn_index)
          if (!tx) return
          tx.status = payload.status
          tx.gasUsed = payload.gas_used
          return
        }

        case 'BlockEnd': {
          const blockNumber = event.block_number
          if (blockNumber === undefined) return
          const entry = inflightRef.current.get(blockNumber)
          if (!entry || entry.block.startTimestamp === undefined) return
          const endTs = BigInt(event.timestamp_ns)
          entry.block.endTimestamp = endTs
          entry.block.executionTime = endTs - entry.block.startTimestamp
          return
        }

        case 'BlockQC': {
          const payload = event.payload
          const blockNumber = event.block_number || payload.block_number
          if (blockNumber === undefined) return
          const entry = inflightRef.current.get(blockNumber)
          if (entry) {
            entry.block.state = 'voted'
          } else {
            updateFinalizedState(blockNumber, 'voted')
          }
          return
        }

        case 'BlockFinalized': {
          const payload = event.payload
          const blockNumber = event.block_number || payload.block_number
          if (blockNumber === undefined) return
          promoteInflightToFinalized(blockNumber, 'finalized')
          return
        }

        case 'BlockVerified': {
          const payload = event.payload
          const blockNumber = event.block_number || payload.block_number
          if (blockNumber === undefined) return
          promoteInflightToFinalized(blockNumber, 'verified')
          return
        }

        default:
          return
      }
    },
    [promoteInflightToFinalized, updateFinalizedState],
  )

  useEvents({
    onEvent: handleEvent,
    eventTypes: EXECUTION_EVENT_TYPES,
  })

  const maxBlockExecutionTime = useMemo(() => {
    return fromNsToMsPrecise(
      finalizedBlocks.reduce(
        (max, block) =>
          block.executionTime && block.executionTime > max
            ? block.executionTime
            : max,
        BigInt(1),
      ),
    )
  }, [finalizedBlocks])

  const normalizedTimeScaleMs = useMemo(() => {
    if (finalizedBlocks.length === 0) return 1

    // Normalize against the larger of:
    // - block wall-time (BlockEnd - BlockStart)
    // - ΣTx execution time (sum of TxnHeaderEnd - TxnHeaderStart)
    // This lets the visualization show when ΣTx > block time (parallel overlap).
    const maxTimes = finalizedBlocks
      .map((block) =>
        Math.max(getBlockWallTimeMs(block), getTotalTransactionTimeMs(block)),
      )
      .filter((time) => time > 0)
      .sort((a, b) => a - b)

    if (maxTimes.length === 0) return 1

    // Use 95th percentile to be resistant to spikes
    const percentileIndex = Math.floor(maxTimes.length * 0.95)
    const percentile95 =
      maxTimes[percentileIndex] || maxTimes[maxTimes.length - 1]

    // Add 10% buffer to prevent clipping of high values near the percentile
    return percentile95 * 1.1
  }, [finalizedBlocks])

  return {
    finalizedBlocks,
    maxBlockExecutionTime,
    normalizedTimeScaleMs,
  }
}
