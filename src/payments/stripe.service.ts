import { Injectable, ServiceUnavailableException } from '@nestjs/common'
import Stripe from 'stripe'

@Injectable()
export class StripeService {
  private _client: Stripe | null = null

  hasConfig(): boolean {
    return Boolean(process.env.STRIPE_SECRET_KEY)
  }

  get client(): Stripe {
    if (!this._client) {
      const key = process.env.STRIPE_SECRET_KEY
      if (!key) throw new ServiceUnavailableException('Payment service is not configured')
      this._client = new Stripe(key)
    }
    return this._client
  }

  constructEvent(rawBody: Buffer, signature: string): Stripe.Event {
    const secret = process.env.STRIPE_WEBHOOK_SECRET
    if (!secret) throw new ServiceUnavailableException('Webhook secret not configured')
    return this.client.webhooks.constructEvent(rawBody, signature, secret)
  }
}
