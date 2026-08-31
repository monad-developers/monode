'use client'

import Image from 'next/image'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Customized,
  XAxis,
  YAxis,
} from 'recharts'
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import { useTotalTransactions } from '@/hooks/use-total-transactions'
import { type TpsDataPoint, useTps } from '@/hooks/use-tps'
import { formatRelativeTime, formatTimeHMS } from '@/lib/timestamp'
import { formatIntNumber } from '@/lib/ui'
import { NetworkActivityStats } from './network-activity-stats'

const chartConfig = {
  tps: {
    label: 'TPS',
    color: 'var(--color-chart-1)',
  },
} satisfies ChartConfig

const SERIES_COLOR = '#6E54FF'
/** Matches recharts' <Area> default so the custom fill looks identical. */
const SERIES_FILL_OPACITY = 0.6

/** Maximum visible time window of the chart, matching the TPS history retained. */
const CHART_WINDOW_MS = 5 * 60 * 1000

/** Smallest window to show early on, so the chart starts zoomed in rather than mostly empty. */
const MIN_WINDOW_MS = 3 * 1000

/**
 * Start zoomed in to the earliest data point and expand the window as data
 * accumulates, capping at CHART_WINDOW_MS once we have 5 minutes of history.
 */
function windowStartAt(earliest: number, now: number): number {
  return Math.max(
    now - CHART_WINDOW_MS,
    Math.min(earliest, now - MIN_WINDOW_MS),
  )
}

/**
 * Fraction of the visible window the x-domain is allowed to jump between React
 * renders. Roughly a pixel on a ~1000px-wide plot, so axis ticks still read as
 * continuously sliding without re-rendering recharts on every frame. The line
 * itself is not bound by this — it is redrawn every frame outside of React (see
 * TpsSeries).
 */
const CLOCK_STEP_FRACTION = 1 / 1000
const CLOCK_MIN_INTERVAL_MS = 16
const CLOCK_MAX_INTERVAL_MS = 100

/**
 * Drives an advancing "now" so the chart's x-domain slides continuously instead
 * of jumping by one slot as each point arrives. The publish rate adapts to the
 * zoom level: a narrow window moves many pixels per millisecond and needs every
 * frame (and holds few points, so it is cheap), while the full 5-minute window
 * crawls and can be published at 10 Hz. rAF auto-pauses when the tab is hidden.
 */
function useSlidingNow(earliest: number | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  const earliestRef = useRef(earliest)

  useEffect(() => {
    earliestRef.current = earliest
  }, [earliest])

  useEffect(() => {
    let raf: number
    let lastPublishedAt = Date.now()
    const tick = () => {
      const current = Date.now()
      const span =
        current - windowStartAt(earliestRef.current ?? current, current)
      const interval = Math.min(
        CLOCK_MAX_INTERVAL_MS,
        Math.max(CLOCK_MIN_INTERVAL_MS, span * CLOCK_STEP_FRACTION),
      )
      if (current - lastPublishedAt >= interval) {
        lastPublishedAt = current
        setNow(current)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return now
}

/**
 * The newest segment is drawn progressively: instead of the last point appearing
 * fully-formed, a head vertex travels from the previous point to the newest one
 * over the inter-arrival interval. Returns null while there is nothing to
 * interpolate, in which case the raw last point is used.
 */
function interpolatedHead(
  history: TpsDataPoint[],
  now: number,
): TpsDataPoint | null {
  if (history.length < 2) return null

  const target = history[history.length - 1]
  const from = history[history.length - 2]
  const duration = target.timestamp - from.timestamp
  if (duration <= 0) return null

  const progress = Math.min(1, Math.max(0, (now - target.timestamp) / duration))
  return {
    timestamp: from.timestamp + (target.timestamp - from.timestamp) * progress,
    tps: from.tps + (target.tps - from.tps) * progress,
  }
}

const round = (value: number) => Math.round(value * 10) / 10

/** Builds the `d` attributes for the line and its filled area below it. */
function buildSeriesPaths(
  history: TpsDataPoint[],
  now: number,
  toX: (timestamp: number) => number,
  toY: (tps: number) => number,
): { line: string; area: string } {
  if (history.length === 0) return { line: '', area: '' }

  const head = interpolatedHead(history, now)
  const lastIndex = history.length - 1

  let line = ''
  for (let i = 0; i < history.length; i++) {
    const point = i === lastIndex && head ? head : history[i]
    line += `${i === 0 ? 'M' : 'L'}${round(toX(point.timestamp))},${round(toY(point.tps))}`
  }

  const baseY = round(toY(0))
  const firstX = round(toX(history[0].timestamp))
  const lastX = round(toX((head ?? history[lastIndex]).timestamp))

  return { line, area: `${line}L${lastX},${baseY}L${firstX},${baseY}Z` }
}

interface RechartsOffset {
  top: number
  left: number
  width: number
  height: number
}

interface TpsSeriesProps {
  history: TpsDataPoint[]
  /** Injected by recharts' <Customized>: the plot rect, in svg coordinates. */
  offset?: RechartsOffset
  /** Injected by recharts' <Customized>: the configured y scales, keyed by axis id. */
  yAxisMap?: Record<string, { scale: (value: number) => number }>
}

/**
 * Draws the TPS line and its gradient fill.
 *
 * This is deliberately not a recharts <Area>: the head vertex and the sliding
 * x-domain both move every frame, and re-rendering recharts at 60 Hz means
 * rebuilding every axis, tick and layer for a series that can hold ~1000 points.
 * Instead recharts re-renders at the (throttled) sliding-clock rate and only
 * these two <path> elements are rewritten per frame, straight through the DOM.
 */
function TpsSeries({ history, offset, yAxisMap }: TpsSeriesProps) {
  const clipId = `tps-clip-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const lineRef = useRef<SVGPathElement>(null)
  const areaRef = useRef<SVGPathElement>(null)
  const latest = useRef<{
    history: TpsDataPoint[]
    offset?: RechartsOffset
    yScale?: (value: number) => number
  }>({ history })

  const draw = useCallback(() => {
    const { history: points, offset: rect, yScale } = latest.current
    if (points.length === 0 || !rect || !yScale) return

    const now = Date.now()
    const start = windowStartAt(points[0].timestamp, now)
    const span = Math.max(1, now - start)
    const toX = (timestamp: number) =>
      rect.left + ((timestamp - start) / span) * rect.width

    const { line, area } = buildSeriesPaths(points, now, toX, yScale)
    lineRef.current?.setAttribute('d', line)
    areaRef.current?.setAttribute('d', area)
  }, [])

  // Keep the frame loop's inputs current and repaint before the browser shows
  // the commit, so a recharts re-render never flashes a stale line.
  useLayoutEffect(() => {
    latest.current = { history, offset, yScale: yAxisMap?.['0']?.scale }
    draw()
  })

  useEffect(() => {
    let raf: number
    const tick = () => {
      draw()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [draw])

  if (!offset) return null

  return (
    <g className="recharts-layer">
      <defs>
        <clipPath id={clipId}>
          <rect
            x={offset.left}
            y={offset.top}
            width={offset.width}
            height={offset.height}
          />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <path
          ref={areaRef}
          fill="url(#tpsGradient)"
          fillOpacity={SERIES_FILL_OPACITY}
          stroke="none"
        />
        <path ref={lineRef} fill="none" stroke={SERIES_COLOR} strokeWidth={2} />
      </g>
    </g>
  )
}

/** Nice, human-friendly tick steps in ms for the relative-time x-axis. */
const TICK_STEPS_MS = [1, 2, 5, 10, 15, 30, 60, 120, 300].map((s) => s * 1000)

/**
 * Builds evenly-spaced ticks anchored at the sliding edge (`end`) and stepping
 * backwards. Anchoring at `end` keeps a single "now" pinned to the far right;
 * supplying ticks explicitly also avoids recharts' auto-generated ticks landing
 * both at the edge and at the current second (which both format as "now").
 */
function buildTicks(start: number, end: number): number[] {
  const step =
    TICK_STEPS_MS.find((s) => s >= (end - start) / 6) ??
    TICK_STEPS_MS[TICK_STEPS_MS.length - 1]

  const ticks: number[] = []
  for (let t = end; t >= start; t -= step) {
    ticks.push(t)
  }
  return ticks.reverse()
}

export function TpsChart() {
  const { currentTps, peakTps, history } = useTps()
  const totalTransactions = useTotalTransactions()
  const hasData = history.length > 0
  const now = useSlidingNow(history[0]?.timestamp)

  const windowStart = windowStartAt(history[0]?.timestamp ?? now, now)
  const ticks = buildTicks(windowStart, now)

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
                  <stop offset="55%" stopColor={SERIES_COLOR} />
                  <stop offset="100%" stopColor="rgba(0, 0, 0, 0)" />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
              <Customized component={<TpsSeries history={history} />} />
              <XAxis
                dataKey="timestamp"
                type="number"
                scale="time"
                domain={[windowStart, now]}
                ticks={ticks}
                allowDataOverflow={true}
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
              {/*
                The visible series is drawn by <TpsSeries> above; this Area is
                kept transparent so recharts still owns the y-domain, the
                tooltip payload and the active dot on hover.
              */}
              <Area
                type="linear"
                dataKey="tps"
                stroke={SERIES_COLOR}
                strokeOpacity={0}
                fill="url(#tpsGradient)"
                fillOpacity={0}
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
