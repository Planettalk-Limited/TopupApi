import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Mailgun from 'mailgun.js'
import * as FormData from 'form-data'

export interface PurchaseConfirmationParams {
  to: string
  productName?: string | null
  amount: number | string
  currency: string
  recipient?: string | null
  reference: string
  token?: string | null
  units?: string | number | null
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Customer-facing purchase confirmation, PlanetTalk-branded. Distinct from
 * `AlertService`, which is ops-only (sends to OPS_ALERT_EMAILS) — this sends to the
 * buyer. Fire-and-forget: never throws — a mail failure must never break fulfilment.
 *
 * Sent from a do-not-reply PlanetTalk address; support queries are routed to
 * care@planettalk.com (stated in the body), not to the from/reply-to address.
 */
@Injectable()
export class CustomerEmailService {
  private readonly logger = new Logger(CustomerEmailService.name)
  private mailgunClient: ReturnType<InstanceType<typeof Mailgun>['client']> | null = null
  private readonly mailgunDomain: string
  // Hardcoded: the customer confirmation always comes from PlanetTalk's websales alias
  // (a from-address on the already-verified planettalk.com Mailgun sending domain — same as
  // the marketing@ sender already in use) and is do-not-reply. No env override.
  private readonly fromEmail = 'PlanetTalk <websales@planettalk.com>'
  private readonly replyTo = 'no-reply@planettalk.com'

  constructor(private readonly config: ConfigService) {
    this.mailgunDomain = this.config.get<string>('MAILGUN_DOMAIN') ?? ''

    const apiKey = this.config.get<string>('MAILGUN_API_KEY')
    const apiUrl = this.config.get<string>('MAILGUN_API_URL') ?? 'https://api.mailgun.net'

    if (apiKey && this.mailgunDomain) {
      try {
        const mailgun = new Mailgun(FormData as unknown as typeof FormData)
        this.mailgunClient = mailgun.client({ username: 'api', key: apiKey, url: apiUrl })
        this.logger.log(`Mailgun customer email ready (domain ${this.mailgunDomain}, endpoint ${apiUrl})`)
      } catch (err) {
        this.logger.error('Failed to init Mailgun client; customer emails disabled', err as Error)
        this.mailgunClient = null
      }
    } else {
      this.logger.warn('Mailgun not configured — customer purchase confirmation emails disabled')
    }
  }

  /**
   * Send a PlanetTalk-branded purchase confirmation to the buyer. Never throws:
   * any failure (missing config, invalid `to`, or a Mailgun rejection) is logged
   * and swallowed so fulfilment is never affected.
   */
  async sendPurchaseConfirmation(params: PurchaseConfirmationParams): Promise<void> {
    try {
      if (!this.mailgunClient) {
        this.logger.warn('sendPurchaseConfirmation: Mailgun not configured — skipping')
        return
      }
      if (!params.to || !EMAIL_RE.test(params.to)) {
        this.logger.warn(`sendPurchaseConfirmation: missing/invalid recipient email — skipping (ref ${params.reference})`)
        return
      }

      const subject = 'Your PlanetTalk purchase — receipt'
      const { html, text } = this.buildBody(params)

      await this.mailgunClient.messages.create(this.mailgunDomain, {
        from: this.fromEmail,
        to: [params.to],
        subject,
        html,
        text,
        'h:Reply-To': this.replyTo,
      })
    } catch (err) {
      this.logger.error(
        `Failed to send purchase confirmation email (ref ${params.reference})`,
        err as Error
      )
    }
  }

  private buildBody(params: PurchaseConfirmationParams): { html: string; text: string } {
    const details: Array<[string, string]> = []
    if (params.productName) details.push(['Product', params.productName])
    details.push(['Amount', `${params.currency} ${params.amount}`])
    if (params.recipient) details.push(['Recipient', params.recipient])
    details.push(['Reference', params.reference])
    if (params.token) details.push(['Electricity token', String(params.token)])
    if (params.units !== undefined && params.units !== null && params.units !== '') {
      details.push(['Units', String(params.units)])
    }

    const supportLine = `Should there be any issue, contact us at care@planettalk.com quoting your reference ${params.reference}.`
    const doNotReplyLine = 'This is an automated message — please do not reply.'

    const textLines = [
      'Dear customer,',
      '',
      'Thank you for your purchase. The transaction was successful. Below are the details:',
      '',
      ...details.map(([label, value]) => `${label}: ${value}`),
      '',
      supportLine,
      '',
      doNotReplyLine,
    ]
    const text = textLines.join('\n')

    const detailRows = details
      .map(
        ([label, value]) =>
          `<tr><td style="padding:4px 12px 4px 0;color:#555;">${escapeHtml(label)}</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(value)}</td></tr>`
      )
      .join('')

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:520px;">
        <p>Dear customer,</p>
        <p>Thank you for your purchase. The transaction was successful. Below are the details:</p>
        <table style="border-collapse:collapse;margin:12px 0;">${detailRows}</table>
        <p>${escapeHtml(supportLine)}</p>
        <p style="color:#777;font-size:12px;">${escapeHtml(doNotReplyLine)}</p>
      </div>
    `.trim()

    return { html, text }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
