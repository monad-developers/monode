'use client'

import Image from 'next/image'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import { useTotalTransactions } from '@/hooks/use-total-transactions'
import { useTps } from '@/hooks/use-tps'
import { formatRelativeTime, formatTimeHMS } from '@/lib/timestamp'
import { formatIntNumber } from '@/lib/ui'
import { NetworkActivityStats } from './network-activity-stats'

const chartConfig = {
  tps: {
    label: 'TPS',
    color: 'var(--color-chart-1)',
  },
} satisfies ChartConfig

export function TpsChart() {
  const { currentTps, peakTps, history } = useTps()
  const totalTransactions = useTotalTransactions()
  const hasData = history.length > 0

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
              data={history}
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
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={80}
                tick={{ fill: 'var(--chart-axis)', fontSize: 12 }}
                tickFormatter={formatRelativeTime}
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
                isAnimationActive={true}
                animationDuration={1000}
                animationEasing="ease-out"
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
