import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Mailgun from 'mailgun.js'
import * as FormData from 'form-data'

export type AlertSeverity = 'info' | 'warning' | 'critical'

/**
 * Operational alerting. Supersedes TopupApp's `sendAlert` (which only posted to
 * a Slack/Discord webhook). Fire-and-forget: never throws — alerting must never
 * break the request that triggered it.
 *
 * Two independent channels, each a no-op if unconfigured:
 *  - Incoming webhook (Slack `text` / Discord `content`) via RELOADLY_ALERT_WEBHOOK_URL
 *  - Email to the ops list via Mailgun (EU API), creds shared with AgentPortalBackend
 */
@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name)
  private mailgunClient: ReturnType<InstanceType<typeof Mailgun>['client']> | null = null
  private readonly mailgunDomain: string
  private readonly fromEmail: string
  private readonly opsRecipients: string[]
  private readonly webhookUrl?: string

  constructor(private readonly config: ConfigService) {
    this.webhookUrl = this.config.get<string>('RELOADLY_ALERT_WEBHOOK_URL')

    this.mailgunDomain = this.config.get<string>('MAILGUN_DOMAIN') ?? ''
    this.fromEmail =
      this.config.get<string>('MAILGUN_FROM_EMAIL') ?? 'PlanetTalk TopUp <marketing@planettalk.com>'
    this.opsRecipients = (this.config.get<string>('OPS_ALERT_EMAILS') ?? '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)

    const apiKey = this.config.get<string>('MAILGUN_API_KEY')
    const apiUrl = this.config.get<string>('MAILGUN_API_URL') ?? 'https://api.mailgun.net'

    if (apiKey && this.mailgunDomain) {
      try {
        const mailgun = new Mailgun(FormData as unknown as typeof FormData)
        this.mailgunClient = mailgun.client({ username: 'api', key: apiKey, url: apiUrl })
        this.logger.log(`Mailgun alerting ready (domain ${this.mailgunDomain}, endpoint ${apiUrl})`)
      } catch (err) {
        this.logger.error('Failed to init Mailgun client; email alerts disabled', err as Error)
        this.mailgunClient = null
      }
    } else {
      this.logger.warn('Mailgun not configured — email alerts disabled (webhook still active if set)')
    }
  }

  /**
   * Send an operational alert to every configured channel. Never throws.
   */
  async notify(message: string, severity: AlertSeverity = 'warning'): Promise<void> {
    const prefix = severity === 'critical' ? '🔴' : severity === 'warning' ? '🟠' : 'ℹ️'
    const text = `${prefix} ${message}`

    await Promise.allSettled([this.sendWebhook(text), this.sendEmail(text, severity)])
  }

  private async sendWebhook(text: string): Promise<void> {
    if (!this.webhookUrl) return
    try {
      await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, content: text }),
      })
    } catch (err) {
      this.logger.error('Alert webhook post failed', err as Error)
    }
  }

  private async sendEmail(text: string, severity: AlertSeverity): Promise<void> {
    if (!this.mailgunClient || this.opsRecipients.length === 0) return
    try {
      await this.mailgunClient.messages.create(this.mailgunDomain, {
        from: this.fromEmail,
        to: this.opsRecipients,
        subject: `[TopUp ${severity.toUpperCase()}] operational alert`,
        text,
      })
    } catch (err) {
      this.logger.error('Alert email send failed', err as Error)
    }
  }
}
