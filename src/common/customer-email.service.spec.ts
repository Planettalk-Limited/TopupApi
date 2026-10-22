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

describe('CustomerEmailService — account emails', () => {
  it('sends the 6-digit verification code, PlanetTalk-branded, with the expiry', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'v-1' })
    const service = new CustomerEmailService(buildConfig())
    withStubbedMailgunClient(service, create)

    await service.sendVerificationCode({ to: 'buyer@example.com', firstName: 'Ada', code: '123456', expiresInMinutes: 15 })

    const [, message] = create.mock.calls[0]
    expect(message.from).toBe('PlanetTalk <websales@planettalk.com>')
    expect(message.to).toEqual(['buyer@example.com'])
    expect(message.subject).toContain('123456')
    for (const body of [message.text, message.html]) {
      expect(body).toContain('Ada')
      expect(body).toContain('123456')
      expect(body).toContain('15 minutes')
      expect(body).toContain('care@planettalk.com')
    }
  })

  it('sends the password reset link built from PUBLIC_SITE_URL and the locale', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'r-1' })
    const service = new CustomerEmailService(buildConfig({ PUBLIC_SITE_URL: 'https://example.test/' }))
    withStubbedMailgunClient(service, create)

    await service.sendPasswordReset({ to: 'buyer@example.com', firstName: 'Ada', token: 'tok_abc', locale: 'fr-fr' })

    const [, message] = create.mock.calls[0]
    const link = 'https://example.test/fr-fr/reset-password?token=tok_abc'
    expect(message.text).toContain(link)
    expect(message.html).toContain(link)
    expect(message.text).toContain('1 hour')
  })

  it('sends the admin reset link to the admin console reset page', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'a-1' })
    const service = new CustomerEmailService(buildConfig({ PUBLIC_SITE_URL: 'https://example.test/' }))
    withStubbedMailgunClient(service, create)

    await service.sendAdminPasswordReset({ to: 'ops@planettalk.com', name: 'Ops', token: 'tok_adm' })

    const [, message] = create.mock.calls[0]
    const link = 'https://example.test/en/admin/reset-password?token=tok_adm'
    expect(message.to).toEqual(['ops@planettalk.com'])
    expect(message.subject).toBe('Reset your PlanetTalk admin password')
    expect(message.text).toContain(link)
    expect(message.html).toContain(link)
  })

  it('wraps account emails in the branded layout, escaping customer-supplied names', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'v-2' })
    const service = new CustomerEmailService(buildConfig({ PUBLIC_SITE_URL: 'https://example.test' }))
    withStubbedMailgunClient(service, create)

    await service.sendVerificationCode({ to: 'buyer@example.com', firstName: '<b>Ada</b>', code: '123456', expiresInMinutes: 15 })

    const { html } = create.mock.calls[0][1]
    expect(html).toContain('https://example.test/images/planettalk-email-header.jpg')
    expect(html).toContain('Connecting Families Worldwide')
    expect(html).toContain('&lt;b&gt;Ada&lt;/b&gt;')
    expect(html).not.toContain('<b>Ada</b>')
    expect(html).not.toMatch(/partner/i)
  })

  it('defaults the reset link to the production site', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'r-2' })
    const service = new CustomerEmailService(buildConfig())
    withStubbedMailgunClient(service, create)

    await service.sendPasswordReset({ to: 'buyer@example.com', firstName: 'Ada', token: 't', locale: 'en' })

    expect(create.mock.calls[0][1].text).toContain('https://mobiletopup.planettalk.com/en/reset-password?token=t')
  })

  it('never throws when Mailgun rejects an account email', async () => {
    const service = new CustomerEmailService(buildConfig())
    withStubbedMailgunClient(service, jest.fn().mockRejectedValue(new Error('down')))

    await expect(
      service.sendVerificationCode({ to: 'buyer@example.com', firstName: 'Ada', code: '1', expiresInMinutes: 15 }),
    ).resolves.toBeUndefined()
    await expect(
      service.sendPasswordReset({ to: 'buyer@example.com', firstName: 'Ada', token: 't', locale: 'en' }),
    ).resolves.toBeUndefined()
  })
})

describe('CustomerEmailService — voucher delivery', () => {
  const params = {
    to: 'friend@example.com',
    productName: 'Market Square gift voucher',
    vouchers: [{ code: '321154121525', pin: '7545', serial: '301126367', expiresAt: '2027-10-22T11:48:04Z', value: 10000 }],
    faceValue: 10000,
    reference: '6ad9f7f319eb7',
  }

  it('sends the code, PIN, value, expiry and how to spend it to the recipient', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'msg-1' })
    const service = new CustomerEmailService(buildConfig())
    withStubbedMailgunClient(service, create)

    await expect(service.sendVoucherDelivery(params)).resolves.toBe(true)

    const [, message] = create.mock.calls[0]
    expect(message.to).toEqual(['friend@example.com'])
    expect(message.subject).toBe('Your Market Square voucher (NGN 10,000)')
    for (const body of [message.text, message.html]) {
      expect(body).toContain('321154121525')
      expect(body).toContain('7545')
      expect(body).toContain('NGN 10,000')
      expect(body).toContain('22 October 2027')
      expect(body).toContain('Here is your Market Square gift voucher from SureGifts, worth NGN 10,000.')
      expect(body).toContain('Spend it at Market Square in Nigeria')
      expect(body).toContain('say you are paying with a SureGifts voucher')
      expect(body).toContain('6ad9f7f319eb7')
    }
  })

  it('resolves false, never throws, when the voucher cannot be sent', async () => {
    const service = new CustomerEmailService(buildConfig())
    withStubbedMailgunClient(service, jest.fn().mockRejectedValue(new Error('mailgun down')))
    await expect(service.sendVoucherDelivery(params)).resolves.toBe(false)

    const unconfigured = new CustomerEmailService(buildConfig({ MAILGUN_API_KEY: '', MAILGUN_DOMAIN: '' }))
    await expect(unconfigured.sendVoucherDelivery(params)).resolves.toBe(false)

    const ok = new CustomerEmailService(buildConfig())
    withStubbedMailgunClient(ok, jest.fn())
    await expect(ok.sendVoucherDelivery({ ...params, to: 'not-an-email' })).resolves.toBe(false)
    await expect(ok.sendVoucherDelivery({ ...params, vouchers: [] })).resolves.toBe(false)
  })
})
