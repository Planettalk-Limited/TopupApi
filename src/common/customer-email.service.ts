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

export interface VerificationCodeParams {
  to: string
  firstName: string
  code: string
  expiresInMinutes: number
}

export interface PasswordResetParams {
  to: string
  firstName: string
  /** Raw single-use token — goes into the link only; the DB holds its SHA-256. */
  token: string
  locale: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DEFAULT_PUBLIC_SITE_URL = 'https://mobiletopup.planettalk.com'
const SUPPORT_LINE = 'Need help? Contact us at care@planettalk.com.'
const DO_NOT_REPLY_LINE = 'This is an automated message — please do not reply.'

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

  /**
   * Email-verification code for a new customer account. Same never-throws contract as
   * the receipt: a mail failure is logged, and the customer can ask for a resend.
   */
  async sendVerificationCode(params: VerificationCodeParams): Promise<void> {
    const paragraphs = [
      `Hi ${params.firstName},`,
      'Use this code to verify your email address and finish creating your PlanetTalk account:',
    ]
    const after = [
      `The code expires in ${params.expiresInMinutes} minutes. If you did not create a PlanetTalk account, you can ignore this email.`,
    ]
    await this.sendAccountEmail('verification code', params.to, `${params.code} is your PlanetTalk verification code`, {
      paragraphs,
      highlight: params.code,
      after,
    })
  }

  /**
   * Password-reset link. The link points at the storefront's reset page
   * (`${PUBLIC_SITE_URL}/${locale}/reset-password?token=…`); the token is single use
   * and expires after an hour (enforced server-side, stated here).
   */
  async sendPasswordReset(params: PasswordResetParams): Promise<void> {
    const base = (this.config.get<string>('PUBLIC_SITE_URL') || DEFAULT_PUBLIC_SITE_URL).replace(/\/+$/, '')
    const link = `${base}/${encodeURIComponent(params.locale)}/reset-password?token=${encodeURIComponent(params.token)}`
    await this.sendAccountEmail('password reset', params.to, 'Reset your PlanetTalk password', {
      paragraphs: [
        `Hi ${params.firstName},`,
        'We received a request to reset the password for your PlanetTalk account. Use the link below to choose a new one:',
      ],
      link,
      after: [
        'The link works once and expires in 1 hour. If you did not ask for this, you can ignore this email — your password will not change.',
      ],
    })
  }

  private async sendAccountEmail(
    kind: string,
    to: string,
    subject: string,
    content: { paragraphs: string[]; highlight?: string; link?: string; after: string[] },
  ): Promise<void> {
    try {
      if (!this.mailgunClient) {
        this.logger.warn(`${kind} email: Mailgun not configured — skipping`)
        return
      }
      if (!to || !EMAIL_RE.test(to)) {
        this.logger.warn(`${kind} email: missing/invalid recipient — skipping`)
        return
      }

      const text = [
        ...content.paragraphs,
        '',
        ...(content.highlight ? [content.highlight, ''] : []),
        ...(content.link ? [content.link, ''] : []),
        ...content.after,
        '',
        SUPPORT_LINE,
        '',
        DO_NOT_REPLY_LINE,
      ].join('\n')

      const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:520px;">
        ${content.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}
        ${
          content.highlight
            ? `<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:16px 0;">${escapeHtml(content.highlight)}</p>`
            : ''
        }
        ${
          content.link
            ? `<p><a href="${escapeHtml(content.link)}" style="display:inline-block;background:#f97316;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;">Reset password</a></p><p style="font-size:12px;color:#555;word-break:break-all;">${escapeHtml(content.link)}</p>`
            : ''
        }
        ${content.after.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}
        <p>${escapeHtml(SUPPORT_LINE)}</p>
        <p style="color:#777;font-size:12px;">${escapeHtml(DO_NOT_REPLY_LINE)}</p>
      </div>
    `.trim()

      await this.mailgunClient.messages.create(this.mailgunDomain, {
        from: this.fromEmail,
        to: [to],
        subject,
        html,
        text,
        'h:Reply-To': this.replyTo,
      })
    } catch (err) {
      this.logger.error(`Failed to send ${kind} email`, err as Error)
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
