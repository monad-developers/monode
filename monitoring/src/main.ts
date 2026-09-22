import { WebClient } from '@slack/web-api'
import dotenv from 'dotenv'
import WebSocket from 'ws'

dotenv.config()

// Constants
const SILENCE_THRESHOLD_MS = Number(process.env.SILENCE_THRESHOLD_MS) || 10_000 // 10 seconds
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS) || 300_000 * 3 // 15 minutes
const HEALTH_CHECK_INTERVAL_MS = 2_000 // 2 seconds
const RECONNECT_BASE_DELAY_MS = 1_000 // 1 second
const RECONNECT_MAX_DELAY_MS = 30_000 // 30 seconds
const CONNECTION_MAX_LIFETIME_MS =
  (Number(process.env.CONNECTION_MAX_LIFETIME_MIN) || 5) * 60 * 1_000 // default 5 minutes

interface Config {
  backendUrl: string
  slackToken: string | undefined
  slackChannel: string | undefined
}

class WebSocketMonitor {
  private config: Config
  private ws: WebSocket | null = null
  private slackClient: WebClient | null = null
  private lastMessageTime: number = Date.now()
  private inFatalState: boolean = false
  private lastNotification: number = 0
  private healthCheckInterval: NodeJS.Timeout | null = null
  private connectionLifetimeTimer: NodeJS.Timeout | null = null
  private reconnectAttempts: number = 0
  private isShuttingDown: boolean = false
  private messageCount: number = 0

  constructor(config: Config) {
    this.config = config
    if (config.slackToken && config.slackChannel) {
      this.slackClient = new WebClient(config.slackToken)
    }
  }

  async start() {
    console.log('Starting Execution Events Monitor...')
    console.log(`Backend URL: ${this.config.backendUrl}`)
    console.log(`Silence threshold: ${SILENCE_THRESHOLD_MS}ms`)
    console.log(`Cooldown period: ${COOLDOWN_MS}ms`)
    console.log(`Connection max lifetime: ${CONNECTION_MAX_LIFETIME_MS / 1000}s`)

    if (!this.slackClient) {
      console.warn(
        '⚠️  Slack notifications disabled (SLACK_TOKEN or SLACK_CHANNEL not configured)',
      )
      console.warn('   Alerts will be logged to console only')
    } else {
      console.log(
        `✓ Slack notifications enabled (channel: ${this.config.slackChannel})`,
      )
    }

    this.connectWebSocket()
    this.startHealthCheck()

    // Send startup alert
    await this.sendOnlineAlert()

    // Graceful shutdown handlers
    process.on('SIGINT', () => this.shutdown('SIGINT'))
    process.on('SIGTERM', () => this.shutdown('SIGTERM'))
  }

  private connectWebSocket() {
    if (this.isShuttingDown) {
      return
    }

    try {
      console.log(`Connecting to ${this.config.backendUrl}...`)
      this.ws = new WebSocket(this.config.backendUrl)

      this.ws.on('open', () => {
        console.log('WebSocket connected')
        this.reconnectAttempts = 0

        // Send subscribe message (must be sent within 10 seconds)
        //const subscribeMessage = {
          //type: 'subscribe',
          //event_filters: [
            //{'event_name': 'BlockStart'}
          //]
        //}
        //this.ws?.send(JSON.stringify(subscribeMessage))
        //console.log('Sent subscribe message')

        // Reset last message time so reconnect gap doesn't trigger false alerts
        this.lastMessageTime = Date.now()

        // Schedule connection refresh to prevent stale connections
        this.scheduleConnectionRefresh()
      })

      this.ws.on('message', () => {
        this.lastMessageTime = Date.now()
        this.messageCount++

        // Log every 100 messages to show activity
        if (this.messageCount % 100 === 0) {
          console.log(
            `Received ${this.messageCount} messages (last: ${new Date(this.lastMessageTime).toISOString()})`,
          )
        }
      })

      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error.message)
      })

      this.ws.on('close', (code, reason) => {
        console.log(
          `WebSocket closed (code: ${code}, reason: ${reason.toString()})`,
        )
        this.ws = null

        if (this.connectionLifetimeTimer) {
          clearTimeout(this.connectionLifetimeTimer)
          this.connectionLifetimeTimer = null
        }

        if (!this.isShuttingDown) {
          this.scheduleReconnect()
        }
      })
    } catch (error) {
      console.error('Failed to create WebSocket connection:', error)
      if (!this.isShuttingDown) {
        this.scheduleReconnect()
      }
    }
  }

  private scheduleConnectionRefresh() {
    if (this.connectionLifetimeTimer) {
      clearTimeout(this.connectionLifetimeTimer)
    }

    this.connectionLifetimeTimer = setTimeout(() => {
      console.log(
        `Connection max lifetime reached (${CONNECTION_MAX_LIFETIME_MS / 1000}s), refreshing connection...`,
      )
      if (this.ws) {
        // Reset attempts so reconnect happens immediately (not an error)
        this.reconnectAttempts = 0
        this.ws.close()
        // The 'close' handler will trigger reconnection via scheduleReconnect
      }
    }, CONNECTION_MAX_LIFETIME_MS)
  }

  private scheduleReconnect() {
    this.reconnectAttempts++
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
      RECONNECT_MAX_DELAY_MS,
    )

    console.log(
      `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`,
    )
    setTimeout(() => this.connectWebSocket(), delay)
  }

  private startHealthCheck() {
    this.healthCheckInterval = setInterval(() => {
      this.checkHealth()
    }, HEALTH_CHECK_INTERVAL_MS)
  }

  private getConnectionStatus(): string {
    if (!this.ws) {
      return 'Disconnected (no connection)'
    }

    switch (this.ws.readyState) {
      case 0:
        return 'Connecting'
      case 1:
        return 'Connected (OPEN)'
      case 2:
        return 'Closing'
      case 3:
        return 'Disconnected (CLOSED)'
      default:
        return 'Unknown'
    }
  }

  private checkHealth() {
    const now = Date.now()
    const silenceDuration = now - this.lastMessageTime

    if (silenceDuration > SILENCE_THRESHOLD_MS) {
      // We're in fatal state (no messages for >10s)
      if (!this.inFatalState) {
        // State transition: Normal → Fatal
        console.log(
          `⚠️  FATAL STATE: No messages for ${(silenceDuration / 1000).toFixed(1)}s`,
        )
        this.inFatalState = true
      }
      // Keep sending alerts while in fatal state (sendFatalAlert handles 5-min cooldown)
      this.sendFatalAlert(silenceDuration)
    } else if (this.inFatalState) {
      // State transition: Fatal → Recovery
      const downtimeDuration =
        now - (this.lastNotification > 0 ? this.lastNotification : now)
      console.log(
        `✅ RECOVERY: Messages resumed after ${(downtimeDuration / 1000).toFixed(1)}s`,
      )
      this.inFatalState = false
      this.sendRecoveryAlert(downtimeDuration)
    }
  }

  private async sendFatalAlert(silenceDuration: number) {
    const now = Date.now()

    // Check cooldown
    if (
      this.lastNotification > 0 &&
      now - this.lastNotification < COOLDOWN_MS
    ) {
      console.log(
        `Skipping alert (cooldown: ${((now - this.lastNotification) / 1000).toFixed(0)}s / ${(COOLDOWN_MS / 1000).toFixed(0)}s)`,
      )
      return
    }

    const lastMessageTimeStr = new Date(this.lastMessageTime).toISOString()
    const currentTimeStr = new Date(now).toISOString()
    const connectionStatus = this.getConnectionStatus()

    // If no Slack client, just log to console
    if (!this.slackClient || !this.config.slackChannel) {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      console.log('🚨 FATAL ALERT: NO MESSAGES RECEIVED')
      console.log(`Service: WebSocket Backend (${this.config.backendUrl})`)
      console.log(`Connection Status: ${connectionStatus}`)
      console.log(
        `Silence Duration: ${(silenceDuration / 1000).toFixed(1)}s (threshold: ${(SILENCE_THRESHOLD_MS / 1000).toFixed(0)}s)`,
      )
      console.log(`Last Message: ${lastMessageTimeStr}`)
      console.log(`Current Time: ${currentTimeStr}`)
      console.log(
        'Status: WebSocket backend has stopped sending events - please investigate',
      )
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      this.lastNotification = now
      return
    }

    try {
      await this.slackClient.chat.postMessage({
        channel: this.config.slackChannel,
        text: '🚨 *Monode Service Alert: NO MESSAGES RECEIVED*',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '🚨 *Monode Service Alert: NO MESSAGES RECEIVED*',
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Service:* Backend \`(${this.config.backendUrl})\``,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Issue:* No messages received for ${(silenceDuration / 1000).toFixed(1)}s (threshold: ${(SILENCE_THRESHOLD_MS / 1000).toFixed(0)}s)`,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*WS Connection Status:* ${connectionStatus}`,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Action Required:* Please check the backend and full node',
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'cc: <@U094E2D06GN> <@U08GQ6KPQNR> <@U090UB05LSD>',
            },
          },
        ],
      })

      this.lastNotification = now
      console.log(
        `Slack fatal alert sent (silence: ${(silenceDuration / 1000).toFixed(1)}s)`,
      )
    } catch (error) {
      console.error('Failed to send Slack fatal alert:', error)
    }
  }

  private async sendRecoveryAlert(downtimeDuration: number) {
    // If no Slack client, just log to console
    if (!this.slackClient || !this.config.slackChannel) {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      console.log('✅ RECOVERY ALERT: MESSAGES RESUMED')
      console.log(`Service: WebSocket Backend (${this.config.backendUrl})`)
      console.log('Status: Backend has resumed sending events')
      console.log(`Downtime: ${(downtimeDuration / 1000).toFixed(1)}s`)
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      return
    }

    try {
      await this.slackClient.chat.postMessage({
        channel: this.config.slackChannel,
        text: '✅ *Monode Service Recovery*',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '✅ *Monode Service Recovery*',
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Service:* Backend \`(${this.config.backendUrl})\``,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Status:* Backend has resumed sending events',
            },
          },
        ],
      })

      console.log(
        `Slack recovery alert sent (downtime: ${(downtimeDuration / 1000).toFixed(1)}s)`,
      )
    } catch (error) {
      console.error('Failed to send Slack recovery alert:', error)
    }
  }

  private async sendOnlineAlert() {
    // If no Slack client, just log to console
    if (!this.slackClient || !this.config.slackChannel) {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      console.log('🟢 MONITOR STARTED')
      console.log(`Service: WebSocket Backend (${this.config.backendUrl})`)
      console.log('Status: Monitor is now online and watching for events')
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      return
    }

    try {
      await this.slackClient.chat.postMessage({
        channel: this.config.slackChannel,
        text: '🟢 *Monode Monitor Service Online*',
        blocks: [],
      })

      console.log('Slack online alert sent')
    } catch (error) {
      console.error('Failed to send Slack online alert:', error)
    }
  }

  private async sendOfflineAlert() {
    // If no Slack client, just log to console
    if (!this.slackClient || !this.config.slackChannel) {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      console.log('🔴 MONITOR STOPPED')
      console.log(`Service: WebSocket Backend (${this.config.backendUrl})`)
      console.log('Status: Monitor has been shut down')
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      return
    }

    try {
      await this.slackClient.chat.postMessage({
        channel: this.config.slackChannel,
        text: '🔴 *Monode Monitor Service Offline*',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '🔴 *Monode Monitor Service Offline*',
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Service:* Monitor',
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Issue:* The Monode Monitor Service process has exited',
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Action Required:* Please check the monitor service on Railway',
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'cc: <@U094E2D06GN> <@U08GQ6KPQNR> <@U090UB05LSD>',
            },
          },
        ],
      })

      console.log('Slack offline alert sent')
    } catch (error) {
      console.error('Failed to send Slack offline alert:', error)
    }
  }

  private async shutdown(signal: string) {
    if (this.isShuttingDown) {
      return
    }

    console.log(`\nReceived ${signal}, shutting down gracefully...`)
    this.isShuttingDown = true

    // Stop health check
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = null
    }

    // Clear connection lifetime timer
    if (this.connectionLifetimeTimer) {
      clearTimeout(this.connectionLifetimeTimer)
      this.connectionLifetimeTimer = null
    }

    // Close WebSocket
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    // Send shutdown alert
    await this.sendOfflineAlert()

    console.log('Execution Events Monitor stopped')
    process.exit(0)
  }
}

// Main entry point
function loadConfig(): Config {
  const backendUrl = process.env.BACKEND_URL
  const slackToken = process.env.SLACK_TOKEN
  const slackChannel = process.env.SLACK_CHANNEL

  if (!backendUrl) {
    throw new Error('BACKEND_URL environment variable is required')
  }

  return {
    backendUrl,
    slackToken,
    slackChannel,
  }
}

async function main() {
  try {
    const config = loadConfig()
    const monitor = new WebSocketMonitor(config)
    await monitor.start()
  } catch (error) {
    console.error('Failed to start monitor:', error)
    process.exit(1)
  }
}

main()
