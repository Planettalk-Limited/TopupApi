import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Mailgun from 'mailgun.js'
import * as FormData from 'form-data'

export interface ApplicationReceivedParams {
  to: string
  jobTitle: string
  applicantFirstName: string
}

export interface NewApplicationAlertParams {
  jobTitle: string
  applicantName: string
  applicationId: string
}

export interface RejectionParams {
  to: string
  applicantFirstName: string
  jobTitle: string
}

/**
 * Careers-specific Mailgun wiring, deliberately isolated from CustomerEmailService/
 * AlertService (own FROM address, own file) — same isolation the Astro careers feature
 * used, carried forward here. Fire-and-forget for applicant-facing sends; sendRejection
 * is the one exception (returns whether it actually sent, so the caller can gate
 * rejectionSentAt and never claim a rejection was sent when it wasn't).
 */
@Injectable()
export class CareersEmailService {
  private readonly logger = new Logger(CareersEmailService.name)
  private mailgunClient: ReturnType<InstanceType<typeof Mailgun>['client']> | null = null
  private readonly domain: string
  private readonly fromEmail: string
  private readonly notifyEmail: string

  constructor(private readonly config: ConfigService) {
    this.domain = this.config.get<string>('MAILGUN_DOMAIN') ?? ''
    this.fromEmail =
      this.config.get<string>('CAREERS_FROM_EMAIL') ?? 'PlanetTalk Careers <jointheclan@planettalk.com>'
    this.notifyEmail = this.config.get<string>('CAREERS_NOTIFY_EMAIL') ?? 'jointheclan@planettalk.com'

    const apiKey = this.config.get<string>('MAILGUN_API_KEY')
    const apiUrl = this.config.get<string>('MAILGUN_API_URL') ?? 'https://api.mailgun.net'

    if (apiKey && this.domain) {
      const mailgun = new Mailgun(FormData as unknown as typeof FormData)
      this.mailgunClient = mailgun.client({ username: 'api', key: apiKey, url: apiUrl })
    } else {
      this.logger.warn('Mailgun not configured — careers emails disabled')
    }
  }

  async sendApplicationReceived(params: ApplicationReceivedParams): Promise<void> {
    if (!this.mailgunClient) return
    try {
      await this.mailgunClient.messages.create(this.domain, {
        from: this.fromEmail,
        to: [params.to],
        subject: `We received your application — ${params.jobTitle}`,
        text: `Hi ${params.applicantFirstName},\n\nThanks for applying to PlanetTalk for the ${params.jobTitle} role. We've received your application and will be in touch.\n\n— The PlanetTalk team`,
      })
    } catch (err) {
      this.logger.error('Failed to send application-received email', err as Error)
    }
  }

  async sendNewApplicationAlert(params: NewApplicationAlertParams): Promise<void> {
    if (!this.mailgunClient) return
    try {
      await this.mailgunClient.messages.create(this.domain, {
        from: this.fromEmail,
        to: [this.notifyEmail],
        subject: `New application: ${params.jobTitle}`,
        text: `${params.applicantName} applied for ${params.jobTitle}.\n\nReview it in the admin console (application ${params.applicationId}).`,
      })
    } catch (err) {
      this.logger.error('Failed to send new-application alert', err as Error)
    }
  }

  async sendRejection(params: RejectionParams): Promise<boolean> {
    if (!this.mailgunClient) return false
    try {
      await this.mailgunClient.messages.create(this.domain, {
        from: this.fromEmail,
        to: [params.to],
        subject: `Update on your application — ${params.jobTitle}`,
        text: `Hi ${params.applicantFirstName},\n\nThank you for your interest in the ${params.jobTitle} role at PlanetTalk. After careful consideration, we've decided not to move forward with your application at this time.\n\nWe appreciate the time you took to apply and wish you the best in your search.\n\n— The PlanetTalk team`,
      })
      return true
    } catch (err) {
      this.logger.error('Failed to send rejection email', err as Error)
      return false
    }
  }
}
