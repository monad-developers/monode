import { Info } from 'lucide-react'
import {
  AnimatedNumber,
  AnimatedNumberGroup,
} from '@/components/ui/animated-number'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface StatItemProps {
  label: string
  value: number
  info?: string
  colorClass?: string
  tooltipDistance?: number
}

interface NetworkActivityStatsProps {
  currentTps: number
  peakTps: number
  totalTransactions: number
}

function StatItem({ label, value, info, tooltipDistance }: StatItemProps) {
  return (
    <div className="flex flex-col items-center gap-2 relative">
      <div className="flex items-end gap-1">
        <span className="text-sm text-text-muted font-normal leading-5 max-w-18 text-center">
          {label}
        </span>
        {info && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Info
                className="size-3 text-text-muted cursor-help absolute top-6 hidden sm:inline-block"
                style={{
                  right: tooltipDistance ? `-${tooltipDistance * 4}px` : '0px',
                }}
              />
            </TooltipTrigger>
            <TooltipContent side="top">{info}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <AnimatedNumber
        value={value}
        format={{
          notation: 'compact',
          minimumFractionDigits: 0,
          maximumFractionDigits: 2,
        }}
        className="text-xl sm:text-2xl font-medium leading-7 font-britti-sans text-text-secondary"
      />
    </div>
  )
}

export const NetworkActivityStats = ({
  currentTps,
  peakTps,
  totalTransactions,
}: NetworkActivityStatsProps) => {
  return (
    <AnimatedNumberGroup>
      <div className="flex justify-between gap-3 sm:gap-7 xs:justify-end">
        <StatItem label="Transactions per second" value={currentTps} />
        <StatItem
          label="Peak Volume"
          value={peakTps}
          info="Highest TPS since page load"
          tooltipDistance={1}
        />
        <StatItem
          label="Total transactions"
          value={totalTransactions}
          info="Total transactions since page load"
          tooltipDistance={5}
        />
      </div>
    </AnimatedNumberGroup>
  )
}
