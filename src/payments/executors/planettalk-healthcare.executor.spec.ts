import { PlanetTalkHealthcareExecutor } from './planettalk-healthcare.executor'
import type { HealthcareFulfillmentOrder } from '../payments.types'

const order: HealthcareFulfillmentOrder = {
  productType: 'healthcare',
  countryCode: 'NG',
  productId: 1951,
  providerAmount: 8094,
  providerCurrency: 'NGN',
  productName: 'Pharmacy: EMZOR PARACETAMOL SYRUP 60ML x2, AMOXICILLIN 500MG CAPS X100 x1',
  email: 'buyer@example.com',
  details: {
    pharmacyCode: 'WHP10431Test',
    isDelivery: true,
    buyerPhone: '+447700900000',
    patient: {
      firstName: 'Ada',
      lastName: 'Obi',
      gender: 'Female',
      phone: '+2348012345678',
      email: 'ada@example.com',
      address: '1 Allen Avenue, Ikeja, Lagos',
    },
    drugs: [
      { drugName: 'EMZOR PARACETAMOL SYRUP 60ML', quantity: 2, unitPrice: 912 },
      { drugName: 'AMOXICILLIN 500MG CAPS X100', quantity: 1, unitPrice: 6270, dose: 'Cap 500mg tds 5/7' },
    ],
  },
}

function makeExecutor(opts: { hasCredentials?: boolean; fetch?: jest.Mock }) {
  const planetTalk = {
    hasCredentials: jest.fn().mockReturnValue(opts.hasCredentials ?? true),
    fetch: opts.fetch ?? jest.fn(),
  } as any
  return { executor: new PlanetTalkHealthcareExecutor(planetTalk), planetTalk }
}

const ok = (data: Record<string, unknown>) =>
  jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ message: 'ok', data }) })

describe('PlanetTalkHealthcareExecutor', () => {
  it('posts the buhibab pharmacy payload as JSON and maps the transaction', async () => {
    const fetch = ok({ id: 108, amount: 8094, status: 'completed', reference: 'abc123' })
    const { executor } = makeExecutor({ fetch })

    const tx = await executor.execute(order, 'pi_1')

    const [url, opts] = fetch.mock.calls[0]
    expect(url).toMatch(/\/products\/1951\/purchase$/)
    expect(opts.method).toBe('POST')
    expect(opts.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(opts.body)).toEqual({
      email: 'buyer@example.com',
      phone: '08012345678',
      pharmacyCode: 'WHP10431Test',
      isDelivery: true,
      fulfilmentService: 'Acute',
      patient: {
        first_name: 'Ada',
        last_name: 'Obi',
        gender: 'Female',
        phone: '08012345678',
        address: '1 Allen Avenue, Ikeja, Lagos',
        email: 'ada@example.com',
      },
      drugs: [
        { name: 'EMZOR PARACETAMOL SYRUP 60ML', unitPrice: 912, quantity: 2, dose: 'As directed' },
        { name: 'AMOXICILLIN 500MG CAPS X100', unitPrice: 6270, quantity: 1, dose: 'Cap 500mg tds 5/7' },
      ],
    })

    expect(tx).toMatchObject({
      transactionId: '108',
      referenceId: 'abc123',
      amount: 8094,
      currency: 'NGN',
      status: 'SUCCESSFUL',
      provider: 'planettalk',
      meta: { pharmacyCode: 'WHP10431Test', isDelivery: true, providerStatus: 'completed' },
    })
  })

  it('treats a non-completed but accepted order (e.g. pending) as placed', async () => {
    const { executor } = makeExecutor({ fetch: ok({ id: 109, status: 'pending', reference: 'r' }) })
    await expect(executor.execute(order, 'pi_1')).resolves.toMatchObject({ status: 'PENDING' })
  })

  it('throws non-retryable with the provider message on the 400 "failed" response', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        message: 'Sorry, an error occurred while placing the pharmacy order. Please check your inputs and try again later.',
        data: { id: 107, status: 'failed' },
      }),
    })
    const { executor } = makeExecutor({ fetch })

    await expect(executor.execute(order, 'pi_1')).rejects.toMatchObject({
      retryable: false,
      statusCode: 400,
      message: expect.stringContaining('placing the pharmacy order'),
    })
  })

  it('throws non-retryable when a 2xx still reports the transaction failed', async () => {
    const { executor } = makeExecutor({ fetch: ok({ id: 110, status: 'failed' }) })
    await expect(executor.execute(order, 'pi_1')).rejects.toMatchObject({ retryable: false })
  })

  it('throws retryable on 5xx', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) })
    const { executor } = makeExecutor({ fetch })
    await expect(executor.execute(order, 'pi_1')).rejects.toMatchObject({ retryable: true, statusCode: 502 })
  })

  it('throws retryable when the request never got a response', async () => {
    const { executor } = makeExecutor({ fetch: jest.fn().mockRejectedValue(new Error('ECONNRESET')) })
    await expect(executor.execute(order, 'pi_1')).rejects.toMatchObject({ retryable: true })
  })

  it('refuses without calling the provider when details are missing', async () => {
    const { executor, planetTalk } = makeExecutor({})
    await expect(executor.execute({ ...order, details: undefined }, 'pi_1')).rejects.toMatchObject({
      retryable: false,
    })
    expect(planetTalk.fetch).not.toHaveBeenCalled()
  })

  it('throws when credentials are not configured', async () => {
    const { executor, planetTalk } = makeExecutor({ hasCredentials: false })
    await expect(executor.execute(order, 'pi_1')).rejects.toThrow('credentials not configured')
    expect(planetTalk.fetch).not.toHaveBeenCalled()
  })
})
