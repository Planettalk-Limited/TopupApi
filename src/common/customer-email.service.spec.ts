import { ConfigService } from '@nestjs/config'
import { CustomerEmailService } from './customer-email.service'

function buildConfig(values: Record<string, string> = {}): ConfigService {
  const defaults: Record<string, string> = {
    MAILGUN_API_KEY: 'test-key',
    MAILGUN_DOMAIN: 'www.planettalk.com',
    MAILGUN_API_URL: 'https://api.eu.mailgun.net',
    ...values,
  }
  return { get: (key: string) => defaults[key] } as unknown as ConfigService
}

// Bypasses the real Mailgun SDK (constructed in the service's ctor) by swapping in a
// stub `messages.create` after construction — keeps these tests focused on
// CustomerEmailService's own message-building/guard logic, not the Mailgun client.
function withStubbedMailgunClient(service: CustomerEmailService, create: jest.Mock): void {
  ;(service as unknown as { mailgunClient: unknown }).mailgunClient = { messages: { create } }
}

describe('CustomerEmailService', () => {
  it('builds the message with the PlanetTalk from/subject/reply-to, care@ contact, and a token+units line when present', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'msg-1' })
    const service = new CustomerEmailService(buildConfig())
    withStubbedMailgunClient(service, create)

    await service.sendPurchaseConfirmation({
      to: 'buyer@example.com',
      productName: 'Electricity Bill Payment',
      amount: 10,
      currency: 'GBP',
      recipient: '1234567890',
      reference: 'pi_test_123',
      token: '1234-5678-9012-3456',
      units: '45.2kWh',
    })

    expect(create).toHaveBeenCalledTimes(1)
    const [domain, message] = create.mock.calls[0]
    expect(domain).toBe('www.planettalk.com')
    expect(message.from).toBe('PlanetTalk <websales@planettalk.com>')
    expect(message.to).toEqual(['buyer@example.com'])
    expect(message.subject).toBe('Your PlanetTalk purchase — receipt')
    expect(message['h:Reply-To']).toBe('no-reply@planettalk.com')

    for (const body of [message.text, message.html]) {
      expect(body).toContain('Dear customer')
      expect(body).toContain('care@planettalk.com')
      expect(body).toContain('pi_test_123')
      expect(body).toContain('Electricity Bill Payment')
      expect(body).toContain('GBP 10')
      expect(body).toContain('1234567890')
      expect(body).toContain('1234-5678-9012-3456')
      expect(body).toContain('45.2kWh')
      expect(body.toLowerCase()).toContain('do not reply')
    }
  })

  it('omits the token/units line when neither is present', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'msg-2' })
    const service = new CustomerEmailService(buildConfig())
    withStubbedMailgunClient(service, create)

    await service.sendPurchaseConfirmation({
      to: 'buyer@example.com',
      amount: 5,
      currency: 'GBP',
      reference: 'pi_test_456',
    })

    const [, message] = create.mock.calls[0]
    expect(message.text).not.toContain('Electricity token')
    expect(message.text).not.toContain('Units')
  })

  it('always sends from the hardcoded PlanetTalk websales@ do-not-reply address (ignores any env override)', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'msg-3' })
    // Even if these env vars are set, the service must use the hardcoded values.
    const service = new CustomerEmailService(
      buildConfig({
        CUSTOMER_EMAIL_FROM: 'Someone Else <spoof@evil.example>',
        CUSTOMER_EMAIL_REPLY_TO: 'spoof-reply@evil.example',
      })
    )
    withStubbedMailgunClient(service, create)

    await service.sendPurchaseConfirmation({ to: 'buyer@example.com', amount: 1, currency: 'GBP', reference: 'ref' })

    const [, message] = create.mock.calls[0]
    expect(message.from).toBe('PlanetTalk <websales@planettalk.com>')
    expect(message['h:Reply-To']).toBe('no-reply@planettalk.com')
  })

  it('is a no-op when Mailgun is unconfigured (no API key/domain)', async () => {
    const service = new CustomerEmailService(buildConfig({ MAILGUN_API_KEY: '', MAILGUN_DOMAIN: '' }))

    await expect(
      service.sendPurchaseConfirmation({ to: 'buyer@example.com', amount: 1, currency: 'GBP', reference: 'ref' })
    ).resolves.toBeUndefined()
    // No mailgunClient was ever constructed, so there's nothing to have been called —
    // the guard at the top of sendPurchaseConfirmation returns before touching it.
    expect((service as unknown as { mailgunClient: unknown }).mailgunClient).toBeNull()
  })

  it('is a no-op when `to` is empty or not a valid email', async () => {
    const create = jest.fn()
    const service = new CustomerEmailService(buildConfig())
    withStubbedMailgunClient(service, create)

    await service.sendPurchaseConfirmation({ to: '', amount: 1, currency: 'GBP', reference: 'ref' })
    await service.sendPurchaseConfirmation({ to: 'not-an-email', amount: 1, currency: 'GBP', reference: 'ref' })

    expect(create).not.toHaveBeenCalled()
  })

  it('never throws when the Mailgun client rejects', async () => {
    const create = jest.fn().mockRejectedValue(new Error('mailgun down'))
    const service = new CustomerEmailService(buildConfig())
    withStubbedMailgunClient(service, create)

    await expect(
      service.sendPurchaseConfirmation({ to: 'buyer@example.com', amount: 1, currency: 'GBP', reference: 'ref' })
    ).resolves.toBeUndefined()
    expect(create).toHaveBeenCalledTimes(1)
  })
})
