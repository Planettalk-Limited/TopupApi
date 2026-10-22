import { appendPurchaseMetadata, buildPurchaseMetadata } from './purchase-metadata'

describe('buildPurchaseMetadata', () => {
  it('carries the Stripe payment intent and order id', () => {
    expect(buildPurchaseMetadata({ paymentIntentId: 'pi_1', orderId: 'order-1' })).toEqual([
      { key: 'stripe_payment_intent', value: 'pi_1' },
      { key: 'order_id', value: 'order-1' },
    ])
  })

  it('skips references we do not have', () => {
    expect(buildPurchaseMetadata({ paymentIntentId: 'pi_1' })).toEqual([{ key: 'stripe_payment_intent', value: 'pi_1' }])
    expect(buildPurchaseMetadata({})).toEqual([])
  })

  it('caps values at buhibab’s 255-character limit', () => {
    const [item] = buildPurchaseMetadata({ paymentIntentId: 'x'.repeat(300) })
    expect(String(item.value)).toHaveLength(255)
  })
})

describe('appendPurchaseMetadata', () => {
  it('encodes the array as indexed form fields', () => {
    const form = new FormData()
    appendPurchaseMetadata(form, [{ key: 'order_id', value: 'order-1' }])
    expect(form.get('metadata[0][key]')).toBe('order_id')
    expect(form.get('metadata[0][value]')).toBe('order-1')
  })
})
