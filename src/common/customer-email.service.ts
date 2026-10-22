import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Mailgun from 'mailgun.js'
import * as FormData from 'form-data'
import {
  button,
  codeBlock,
  detailsTable,
  heading,
  linkBox,
  mutedParagraph,
  paragraph,
  renderEmailLayout,
  warningBox,
} from './email-layout'

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

export interface VoucherDeliveryParams {
  to: string
  /** e.g. "Market Square gift voucher". */
  productName?: string | null
  vouchers: Array<{ code: string; pin?: string; serial?: string; expiresAt?: string; value?: number }>
  /** Face value in NGN, used when buhibab gives no per-voucher value. */
  faceValue: number
  reference: string
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

export interface AdminPasswordResetParams {
  to: string
  name: string
  /** Raw single-use token — goes into the link only; the DB holds its SHA-256. */
  token: string
}

const EMAIL_RE =/^[^\s@]+@[^\s@]+\.[^\s@]+$/
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
   * Delivers a gift voucher to its recipient: code, PIN, value, expiry and how to spend
   * it. We are the only sender — buhibab returns the voucher and emails no one — so this
   * resolves false on any failure, and the caller alerts ops rather than leaving a
   * customer who paid without their voucher.
   */
  async sendVoucherDelivery(params: VoucherDeliveryParams): Promise<boolean> {
    try {
      if (!this.mailgunClient) {
        this.logger.error(`sendVoucherDelivery: Mailgun not configured (ref ${params.reference})`)
        return false
      }
      if (!params.to || !EMAIL_RE.test(params.to) || params.vouchers.length === 0) {
        this.logger.error(`sendVoucherDelivery: no valid recipient or voucher (ref ${params.reference})`)
        return false
      }

      const product = params.productName?.trim() || 'gift voucher'
      const brand = product.replace(/\s+gift voucher$/i, '')
      const naira = (n: number) => `NGN ${n.toLocaleString('en-NG')}`
      const date = (iso?: string) => {
        const d = iso ? new Date(iso) : null
        return d && !Number.isNaN(d.getTime())
          ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Lagos' })
          : null
      }
      const total = params.vouchers.reduce((sum, v) => sum + (v.value ?? 0), 0) || params.faceValue
      const several = params.vouchers.length > 1

      const voucherRows = params.vouchers.map((v) => {
        const rows: Array<[string, string]> = [['Voucher code', v.code]]
        if (v.pin) rows.push(['PIN', v.pin])
        rows.push(['Value', naira(v.value ?? (several ? 0 : params.faceValue))])
        const until = date(v.expiresAt)
        if (until) rows.push(['Valid until', until])
        if (v.serial) rows.push(['Serial number', v.serial])
        return rows
      })

      const howTo = [
        `Spend it at ${brand} in Nigeria, in store, or online where ${brand} sells online.`,
        'At the till or checkout, say you are paying with a gift voucher and give the voucher code and PIN.',
        'Keep this email safe: anyone with the code and PIN can spend the voucher.',
      ]
      const supportLine = `Something wrong? Contact us at care@planettalk.com quoting reference ${params.reference}.`

      const subject = `Your ${brand} voucher (${naira(total)})`
      const html = this.layout('Your voucher is ready', subject, [
        heading('Your voucher is ready'),
        paragraph(`Here is your ${product}, worth ${naira(total)}.`),
        ...voucherRows.flatMap((rows) => [codeBlock(rows[0][1]), detailsTable(rows.slice(1))]),
        heading('How to use it'),
        ...howTo.map(paragraph),
        paragraph(supportLine),
      ])
      const text = [
        `Here is your ${product}, worth ${naira(total)}.`,
        '',
        ...voucherRows.flatMap((rows) => [...rows.map(([label, value]) => `${label}: ${value}`), '']),
        'How to use it',
        ...howTo.map((line) => `- ${line}`),
        '',
        supportLine,
        '',
        DO_NOT_REPLY_LINE,
      ].join('\n')

      await this.mailgunClient.messages.create(this.mailgunDomain, {
        from: this.fromEmail,
        to: [params.to],
        subject,
        html,
        text,
        'h:Reply-To': this.replyTo,
      })
      return true
    } catch (err) {
      this.logger.error(`Failed to send voucher delivery email (ref ${params.reference})`, err as Error)
      return false
    }
  }

  /**
   * Email-verification code for a new customer account. Same never-throws contract as
   * the receipt: a mail failure is logged, and the customer can ask for a resend.
   */
  async sendVerificationCode(params: VerificationCodeParams): Promise<void> {
    const expiry = `This code expires in ${params.expiresInMinutes} minutes.`
    const text = [
      `Hi ${params.firstName},`,
      '',
      'Use this code to verify your email address and finish creating your PlanetTalk account:',
      '',
      params.code,
      '',
      expiry,
      '',
      'If you did not create a PlanetTalk account, you can ignore this email.',
    ]
    const html = this.layout('Verify your email', `Your PlanetTalk verification code is ${params.code}`, [
      heading('Verify your email'),
      paragraph(`Hi ${params.firstName},`),
      paragraph('Use this code to verify your email address and finish creating your PlanetTalk account:'),
      codeBlock(params.code),
      warningBox(expiry),
      paragraph('Enter the 6-digit code on the PlanetTalk website to complete sign-up.'),
      mutedParagraph("Didn't create a PlanetTalk account? You can safely ignore this email - no account is created without this code."),
    ])
    await this.sendAccountEmail('verification code', params.to, `${params.code} is your PlanetTalk verification code`, { html, text })
  }

  /**
   * Password-reset link. The link points at the storefront's reset page
   * (`${PUBLIC_SITE_URL}/${locale}/reset-password?token=…`); the token is single use
   * and expires after an hour (enforced server-side, stated here).
   */
  async sendPasswordReset(params: PasswordResetParams): Promise<void> {
    const link = `${this.siteUrl()}/${encodeURIComponent(params.locale)}/reset-password?token=${encodeURIComponent(params.token)}`
    const intro = 'We received a request to reset the password for your PlanetTalk account. Use the button below to choose a new one.'
    const expiry = 'This link works once and expires in 1 hour.'
    const ignore = 'If you did not ask for this, you can ignore this email - your password will not change.'
    const text = [`Hi ${params.firstName},`, '', intro, '', link, '', expiry, '', ignore]
    const html = this.layout('Reset your password', 'Reset your PlanetTalk password', [
      heading('Reset your password'),
      paragraph(`Hi ${params.firstName},`),
      paragraph(intro),
      button(link, 'Reset your password'),
      linkBox(link),
      warningBox(expiry),
      mutedParagraph(ignore),
    ])
    await this.sendAccountEmail('password reset', params.to, 'Reset your PlanetTalk password', { html, text })
  }

  /**
   * Admin console "forgot password" link. Points at the console's reset page
   * (`${PUBLIC_SITE_URL}/en/admin/reset-password?token=…`); single use, 1 hour.
   */
  async sendAdminPasswordReset(params: AdminPasswordResetParams): Promise<void> {
    const link = `${this.siteUrl()}/en/admin/reset-password?token=${encodeURIComponent(params.token)}`
    const intro = 'We received a request to reset the password for your PlanetTalk admin console account. Use the button below to choose a new one.'
    const expiry = 'This link works once and expires in 1 hour.'
    const ignore = 'If you did not ask for this, you can ignore this email - your password will not change.'
    const text = [`Hi ${params.name},`, '', intro, '', link, '', expiry, '', ignore]
    const html = this.layout('Reset your admin password', 'Reset your PlanetTalk admin password', [
      heading('Reset your admin password'),
      paragraph(`Hi ${params.name},`),
      paragraph(intro),
      button(link, 'Reset your password'),
      linkBox(link),
      warningBox(expiry),
      mutedParagraph(ignore),
    ])
    await this.sendAccountEmail('admin password reset', params.to, 'Reset your PlanetTalk admin password', { html, text })
  }

  private siteUrl(): string {
    return (this.config.get<string>('PUBLIC_SITE_URL') || DEFAULT_PUBLIC_SITE_URL).replace(/\/+$/, '')
  }

  private layout(title: string, previewText: string, blocks: string[]): string {
    return renderEmailLayout({ siteUrl: this.siteUrl(), title, previewText, body: blocks.join('\n') })
  }

  private async sendAccountEmail(
    kind: string,
    to: string,
    subject: string,
    content: { html: string; text: string[] },
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

      const text = [...content.text, '', SUPPORT_LINE, '', DO_NOT_REPLY_LINE].join('\n')

      await this.mailgunClient.messages.create(this.mailgunDomain, {
        from: this.fromEmail,
        to: [to],
        subject,
        html: content.html,
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

    const html = this.layout('Payment successful', `Your PlanetTalk receipt - ${params.reference}`, [
      heading('Payment successful'),
      paragraph('Dear customer,'),
      paragraph('Thank you for your purchase. The transaction was successful. Below are the details:'),
      detailsTable(details),
      paragraph(supportLine),
    ])

    return { html, text }
  }
}
