'use client'

import { useCallback, useState } from 'react'
import { decodeEventLog, type Hex, zeroAddress } from 'viem'
import {
  EVENT_ABIS,
  getTokenByAddress,
  SWAP_PROVIDER_CONFIG,
  type SwapProvider,
} from '@/constants/swap-provider-config'
import { AUSD_ADDRESS, WMON_ADDRESS } from '@/constants/transfer-config'
import { useEvents } from '@/hooks/use-events'
import { parseTopicsString } from '@/lib/abi-decode'
import type { EventName, SerializableEventData } from '@/types/events'
import type { SwapData } from '@/types/swap'

const MAX_SWAPS = 2000
const SWAP_EVENT_TYPES: readonly EventName[] = ['TxnLog']

/**
 * Parse raw log data into normalized SwapData based on the provider
 */
function parseSwapEvent(
  event: SerializableEventData,
  provider: SwapProvider,
): SwapData | null {
  if (event.payload.type !== 'TxnLog') {
    return null
  }

  const { data } = event.payload
  const topicsRaw = parseTopicsString(event.payload.topics as string | string[])
  const topics = topicsRaw as Hex[]
  const dataHex = data as Hex
  const blockNumber = event.block_number ?? 0
  const txnIdx = event.txn_idx ?? 0
  const txHash = event.txn_hash

  const id = `${blockNumber}-${txnIdx}-${event.seqno}`
  const timestamp = Number(BigInt(event.timestamp_ns) / BigInt(1_000_000))

  try {
    let swap: SwapData | null = null
    switch (provider) {
      case 'kuru':
        swap = parseKuruFlowSwap(id, topics, dataHex, blockNumber, timestamp)
        break
      case 'monorail':
        swap = parseMonorailAggregated(
          id,
          topics,
          dataHex,
          blockNumber,
          timestamp,
        )
        break
      case 'uniswap-v4':
        swap = parseUniswapV4Swap(id, topics, dataHex, blockNumber, timestamp)
        break
      case 'pancakeswap-v3':
        swap = parsePancakeSwapV3Swap(
          id,
          topics,
          dataHex,
          blockNumber,
          timestamp,
        )
        break
      case 'kyberswap':
        swap = parseKyberSwapSwap(id, topics, dataHex, blockNumber, timestamp)
        break
      case 'openocean':
        swap = parseOpenOceanSwap(id, topics, dataHex, blockNumber, timestamp)
        break
    }
    if (swap) {
      swap.txHash = txHash ?? ''
    }
    return swap
  } catch {
    return null
  }
}

/**
 * Parse Uniswap V4 Swap event using viem's decodeEventLog
 * Positive = tokens sent (in), Negative = tokens received (out)
 * token0 = MON, token1 = AUSD for this pool
 */
function parseUniswapV4Swap(
  id: string,
  topics: Hex[],
  data: Hex,
  blockNumber: number,
  timestamp: number,
): SwapData {
  const decoded = decodeEventLog({
    abi: EVENT_ABIS.uniswapV4,
    data,
    topics: topics as [Hex, ...Hex[]],
  })

  const { sender, amount0, amount1 } = decoded.args

  if (amount0 > BigInt(0)) {
    return {
      id,
      provider: 'uniswap-v4',
      blockNumber,
      timestamp,
      sender,
      amountIn: amount0.toString(),
      amountOut: (-amount1).toString(),
      tokenIn: 'MON',
      tokenOut: 'AUSD',
      txHash: '',
      tokenInAddress: zeroAddress,
      tokenOutAddress: AUSD_ADDRESS,
    }
  }

  return {
    id,
    provider: 'uniswap-v4',
    blockNumber,
    timestamp,
    sender,
    amountIn: amount1.toString(),
    amountOut: (-amount0).toString(),
    tokenIn: 'AUSD',
    tokenOut: 'MON',
    txHash: '',
    tokenInAddress: AUSD_ADDRESS,
    tokenOutAddress: zeroAddress,
  }
}

/**
 * Parse PancakeSwap V3 Swap event using viem's decodeEventLog
 * Positive amount = tokens going INTO pool (user sends), Negative = tokens going OUT of pool (user receives)
 * Pool is AUSD/WMON: token0 = AUSD (6 decimals), token1 = WMON (18 decimals)
 */
function parsePancakeSwapV3Swap(
  id: string,
  topics: Hex[],
  data: Hex,
  blockNumber: number,
  timestamp: number,
): SwapData {
  const decoded = decodeEventLog({
    abi: EVENT_ABIS.pancakeswapV3,
    data,
    topics: topics as [Hex, ...Hex[]],
  })

  const { sender, recipient, amount0, amount1 } = decoded.args
  const isSellingAUSD = amount0 > BigInt(0)

  return {
    id,
    provider: 'pancakeswap-v3',
    blockNumber,
    timestamp,
    sender,
    recipient,
    amountIn: isSellingAUSD ? amount0.toString() : amount1.toString(),
    amountOut: isSellingAUSD ? (-amount1).toString() : (-amount0).toString(),
    tokenIn: isSellingAUSD ? 'AUSD' : 'WMON',
    tokenOut: isSellingAUSD ? 'WMON' : 'AUSD',
    txHash: '',
    tokenInAddress: isSellingAUSD ? AUSD_ADDRESS : WMON_ADDRESS,
    tokenOutAddress: isSellingAUSD ? WMON_ADDRESS : AUSD_ADDRESS,
  }
}

function parseKuruFlowSwap(
  id: string,
  topics: Hex[],
  data: Hex,
  blockNumber: number,
  timestamp: number,
): SwapData {
  const decoded = decodeEventLog({
    abi: EVENT_ABIS.kuru,
    data,
    topics: topics as [Hex, ...Hex[]],
  })

  const { user, tokenIn, tokenOut, amountIn, amountOut } = decoded.args
  const tokenInInfo = getTokenByAddress(tokenIn)
  const tokenOutInfo = getTokenByAddress(tokenOut)

  return {
    id,
    provider: 'kuru',
    blockNumber,
    timestamp,
    sender: user,
    amountIn: amountIn.toString(),
    amountOut: amountOut.toString(),
    tokenIn: tokenInInfo?.symbol ?? truncateAddress(tokenIn),
    tokenOut: tokenOutInfo?.symbol ?? truncateAddress(tokenOut),
    tokenInAddress: tokenIn,
    tokenOutAddress: tokenOut,
    txHash: '',
  }
}

function parseMonorailAggregated(
  id: string,
  topics: Hex[],
  data: Hex,
  blockNumber: number,
  timestamp: number,
): SwapData {
  const decoded = decodeEventLog({
    abi: EVENT_ABIS.monorail,
    data,
    topics: topics as [Hex, ...Hex[]],
  })

  const { sender, tokenIn, tokenOut, amountIn, amountOut } = decoded.args
  const tokenInInfo = getTokenByAddress(tokenIn)
  const tokenOutInfo = getTokenByAddress(tokenOut)

  return {
    id,
    provider: 'monorail',
    blockNumber,
    timestamp,
    sender,
    amountIn: amountIn.toString(),
    amountOut: amountOut.toString(),
    tokenIn: tokenInInfo?.symbol ?? truncateAddress(tokenIn),
    tokenOut: tokenOutInfo?.symbol ?? truncateAddress(tokenOut),
    tokenInAddress: tokenIn,
    tokenOutAddress: tokenOut,
    txHash: '',
  }
}

function parseKyberSwapSwap(
  id: string,
  topics: Hex[],
  data: Hex,
  blockNumber: number,
  timestamp: number,
): SwapData {
  const decoded = decodeEventLog({
    abi: EVENT_ABIS.kyberswap,
    data,
    topics: topics as [Hex, ...Hex[]],
  })

  const { sender, srcToken, dstToken, dstReceiver, spentAmount, returnAmount } =
    decoded.args
  const tokenInInfo = getTokenByAddress(srcToken)
  const tokenOutInfo = getTokenByAddress(dstToken)

  return {
    id,
    provider: 'kyberswap',
    blockNumber,
    timestamp,
    sender,
    recipient: dstReceiver,
    amountIn: spentAmount.toString(),
    amountOut: returnAmount.toString(),
    tokenIn: tokenInInfo?.symbol ?? truncateAddress(srcToken),
    tokenOut: tokenOutInfo?.symbol ?? truncateAddress(dstToken),
    tokenInAddress: srcToken,
    tokenOutAddress: dstToken,
    txHash: '',
  }
}

function parseOpenOceanSwap(
  id: string,
  topics: Hex[],
  data: Hex,
  blockNumber: number,
  timestamp: number,
): SwapData {
  const decoded = decodeEventLog({
    abi: EVENT_ABIS.openocean,
    data,
    topics: topics as [Hex, ...Hex[]],
  })

  const { sender, srcToken, dstToken, dstReceiver, spentAmount, returnAmount } =
    decoded.args
  const tokenInInfo = getTokenByAddress(srcToken)
  const tokenOutInfo = getTokenByAddress(dstToken)

  return {
    id,
    provider: 'openocean',
    blockNumber,
    timestamp,
    sender,
    recipient: dstReceiver,
    amountIn: spentAmount.toString(),
    amountOut: returnAmount.toString(),
    tokenIn: tokenInInfo?.symbol ?? truncateAddress(srcToken),
    tokenOut: tokenOutInfo?.symbol ?? truncateAddress(dstToken),
    tokenInAddress: srcToken,
    tokenOutAddress: dstToken,
    txHash: '',
  }
}

/**
 * Truncate address for display when token not found in list
 */
function truncateAddress(address: string): string {
  return `${address.slice(0, 5)}..`
}

/**
 * Hook to subscribe to and process swap events from all configured DEXs
 */
export function useSwapEvents() {
  const [allSwaps, setAllSwaps] = useState<SwapData[]>([])

  const handleEvent = useCallback((event: SerializableEventData) => {
    if (event.payload.type !== 'TxnLog') return

    const address = event.payload.address.toLowerCase()
    // Topics may come as concatenated string, parse into array
    const topics = parseTopicsString(event.payload.topics as string | string[])

    const matchingConfig = SWAP_PROVIDER_CONFIG.find((config) => {
      if (config.contractAddress.toLowerCase() !== address) return false
      return config.eventTopics.every(
        (t, i) => topics[i]?.toLowerCase() === t.toLowerCase(),
      )
    })

    if (!matchingConfig) return

    const swapData = parseSwapEvent(event, matchingConfig.provider)
    if (!swapData) return

    setAllSwaps((prev) => {
      const next = [swapData, ...prev]
      if (next.length > MAX_SWAPS) {
        return next.slice(0, Math.ceil(MAX_SWAPS / 3))
      }
      return next
    })
  }, [])

  const { isConnected } = useEvents({
    onEvent: handleEvent,
    eventTypes: SWAP_EVENT_TYPES,
  })

  const clearSwaps = useCallback(() => {
    setAllSwaps([])
  }, [])

  return {
    allSwaps,
    isConnected,
    clearSwaps,
  }
}
