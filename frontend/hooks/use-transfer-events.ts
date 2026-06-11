'use client'

import { useCallback, useState } from 'react'
import { decodeEventLog, type Hex } from 'viem'
import {
  ERC20_TRANSFER_ABI,
  ERC20_TRANSFER_TOPIC,
  WMON_ADDRESS,
} from '@/constants/transfer-config'
import { useEvents } from '@/hooks/use-events'
import { parseTopicsString } from '@/lib/abi-decode'
import type { EventName, SerializableEventData } from '@/types/events'
import type { TransferData } from '@/types/transfer'

const MAX_TRANSFERS = 5000
const TRANSFER_EVENT_TYPES: readonly EventName[] = ['TxnCallFrame', 'TxnLog']

/**
 * Parse native transfer event (TxnCallFrame with non-zero value)
 */
function parseNativeTransfer(
  event: SerializableEventData,
): TransferData | null {
  if (event.payload.type !== 'TxnCallFrame') {
    return null
  }

  const { caller, call_target, value } = event.payload
  const blockNumber = event.block_number ?? 0
  const txnIdx = event.txn_idx ?? 0
  const txHash = event.txn_hash ?? ''

  const id = `native-${blockNumber}-${txnIdx}-${event.seqno}`
  const timestamp = Number(BigInt(event.timestamp_ns) / BigInt(1_000_000))

  return {
    id,
    type: 'native',
    txHash,
    blockNumber,
    timestamp,
    from: caller,
    to: call_target,
    value,
  }
}

/**
 * Parse WMON ERC20 Transfer event
 */
function parseWmonTransfer(event: SerializableEventData): TransferData | null {
  if (event.payload.type !== 'TxnLog') {
    return null
  }

  const { data } = event.payload
  const topicsRaw = parseTopicsString(event.payload.topics as string | string[])
  const topics = topicsRaw as Hex[]
  const dataHex = data as Hex
  const blockNumber = event.block_number ?? 0
  const txnIdx = event.txn_idx ?? 0
  const txHash = event.txn_hash ?? ''

  const id = `wmon-${blockNumber}-${txnIdx}-${event.seqno}`
  const timestamp = Number(BigInt(event.timestamp_ns) / BigInt(1_000_000))

  try {
    const decoded = decodeEventLog({
      abi: ERC20_TRANSFER_ABI,
      data: dataHex,
      topics: topics as [Hex, ...Hex[]],
    })

    const { from, to, value } = decoded.args

    return {
      id,
      type: 'wmon',
      txHash,
      blockNumber,
      timestamp,
      from,
      to,
      value: value.toString(),
    }
  } catch {
    return null
  }
}

/**
 * Hook to subscribe to and process transfer events (native MON + WMON)
 */
export function useTransferEvents() {
  const [allTransfers, setAllTransfers] = useState<TransferData[]>([])
  const [cumulativeTransferred, setCumulativeTransferred] = useState<bigint>(
    BigInt(0),
  )

  const handleEvent = useCallback((event: SerializableEventData) => {
    let transferData: TransferData | null = null

    if (event.payload.type === 'TxnCallFrame') {
      transferData = parseNativeTransfer(event)
    } else if (event.payload.type === 'TxnLog') {
      const address = event.payload.address.toLowerCase()
      const topics = event.payload.topics
      if (
        address === WMON_ADDRESS.toLowerCase() &&
        topics.at(0)?.toLowerCase() === ERC20_TRANSFER_TOPIC.toLowerCase()
      ) {
        transferData = parseWmonTransfer(event)
      }
    }

    if (!transferData) return

    setAllTransfers((prev) => {
      const next = [transferData, ...prev]
      if (next.length > MAX_TRANSFERS) {
        return next.slice(0, Math.ceil(MAX_TRANSFERS / 3))
      }
      return next
    })

    // Update cumulative total
    setCumulativeTransferred((prev) => prev + BigInt(transferData.value))
  }, [])

  const { isConnected } = useEvents({
    onEvent: handleEvent,
    eventTypes: TRANSFER_EVENT_TYPES,
  })

  const clearTransfers = useCallback(() => {
    setAllTransfers([])
    setCumulativeTransferred(BigInt(0))
  }, [])

  return {
    allTransfers,
    isConnected,
    clearTransfers,
    cumulativeTransferred,
  }
}
