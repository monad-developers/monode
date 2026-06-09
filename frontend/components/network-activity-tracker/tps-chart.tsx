'use client'

import Image from 'next/image'
import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import { useSmoothedTpsHistory } from '@/hooks/use-smoothed-tps-history'
import { useTotalTransactions } from '@/hooks/use-total-transactions'
import { TPS_HISTORY_DURATION_MS, useTps } from '@/hooks/use-tps'
import { formatRelativeTime, formatTimeHMS } from '@/lib/timestamp'
import { formatIntNumber } from '@/lib/ui'
import { NetworkActivityStats } from './network-activity-stats'

const chartConfig = {
  tps: {
    label: 'TPS',
    color: 'var(--color-chart-1)',
  },
} satisfies ChartConfig

/**
 * Pin tick labels to absolute 30-second boundaries within the visible domain.
 * Because each tick has a fixed timestamp, its pixel position is purely a
 * function of the smoothly-advancing domain — so ticks slide left continuously
 * with the chart instead of being re-picked by recharts when the data set
 * grows. Once a minute the leftmost tick slides off-screen and a new one
 * appears at the right edge.
 */
const TICK_INTERVAL_MS = 30_000

function buildTicks(minTimestamp: number, maxTimestamp: number): number[] {
  const ticks: number[] = []
  let t = Math.floor(maxTimestamp / TICK_INTERVAL_MS) * TICK_INTERVAL_MS
  while (t >= minTimestamp) {
    ticks.push(t)
    t -= TICK_INTERVAL_MS
  }
  return ticks.reverse()
}

export function TpsChart() {
  const { currentTps, peakTps, history } = useTps()
  const smoothedHistory = useSmoothedTpsHistory(history)
  const totalTransactions = useTotalTransactions()
  const hasData = smoothedHistory.length > 0

  // Anchor both edges of the domain to the smoothly-advancing tip so the
  // axis scrolls continuously. Anchoring the left edge to `latest - window`
  // (instead of the oldest history point) prevents a jump at the left every
  // time `useTps` drops an expired point.
  const xDomain = useMemo<[number, number] | undefined>(() => {
    if (smoothedHistory.length === 0) return undefined
    const latest = smoothedHistory[smoothedHistory.length - 1].timestamp
    return [latest - TPS_HISTORY_DURATION_MS, latest]
  }, [smoothedHistory])

  const xTicks = useMemo(() => {
    if (xDomain === undefined) return undefined
    return buildTicks(xDomain[0], xDomain[1])
  }, [xDomain])

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-col gap-3 pb-10 xs:flex-row xs:items-start xs:justify-between">
        <div className="flex flex-col gap-0.5">
          <div className="flex flex-row gap-1">
            <span className="text-2xl font-medium text-white font-britti-sans leading-7">
              Transaction volume
            </span>
            <Image
              src="/live-dot.svg"
              alt="live indicator"
              width={24}
              height={24}
            />
          </div>
          <span className="text-sm text-text-secondary">
            for the last 5 minutes
          </span>
        </div>
        <NetworkActivityStats
          currentTps={currentTps}
          peakTps={peakTps}
          totalTransactions={totalTransactions}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
        {hasData ? (
          <ChartContainer
            config={chartConfig}
            className="h-full min-w-2xl w-full p-0"
          >
            <AreaChart
              data={smoothedHistory}
              margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            >
              <defs>
                <linearGradient
                  id="tpsGradient"
                  x1="0%"
                  y1="0%"
                  x2="0%"
                  y2="100%"
                >
                  <stop offset="55%" stopColor="#6E54FF" />
                  <stop offset="100%" stopColor="rgba(0, 0, 0, 0)" />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
              <XAxis
                dataKey="timestamp"
                type="number"
                domain={xDomain ?? ['dataMin', 'dataMax']}
                ticks={xTicks}
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={80}
                tick={{ fill: 'var(--chart-axis)', fontSize: 12 }}
                tickFormatter={formatRelativeTime}
                allowDataOverflow
              />
              <YAxis
                domain={[0, 'auto']}
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tick={{ fill: 'var(--chart-axis)', fontSize: 12 }}
                tickFormatter={formatIntNumber}
                width={48}
                allowDataOverflow={true}
              />
              <ChartTooltip
                cursor={{
                  stroke: 'var(--chart-cursor)',
                  strokeDasharray: '4 4',
                }}
                content={
                  <ChartTooltipContent
                    className="bg-zinc-900 border-zinc-700"
                    labelClassName="text-zinc-400"
                    labelFormatter={(_, payload) => {
                      const ts = payload?.[0]?.payload?.timestamp
                      return ts ? formatTimeHMS(ts) : ''
                    }}
                    formatter={(value) => (
                      <span className="font-mono font-semibold tabular-nums text-white">
                        {formatIntNumber(Number(value))} TPS
                      </span>
                    )}
                    hideIndicator
                  />
                }
              />
              <Area
                type="linear"
                dataKey="tps"
                stroke="#6E54FF"
                strokeWidth={2}
                fill="url(#tpsGradient)"
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ChartContainer>
        ) : (
          <div className="size-full flex items-center justify-center">
            <p className="text-sm text-text-secondary">Waiting for data...</p>
          </div>
        )}
      </div>
    </div>
  )
}
