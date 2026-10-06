import { buildOperatorsFromProducts, resolveProductId } from './planettalk.mappers'
import type { PlanetTalkProductGroup } from './planettalk.types'

function product(id: number, name: string, value: number): any {
  return {
    id,
    name,
    operator_name: 'Airtel',
    operator_logo: null,
    value_amount: value,
    price: value / 1500,
    value_amount_max: null,
    price_max: null,
    fixed_price: true,
    destination_country: { id: 1, name: 'Nigeria', iso: 'NG' },
    additional_fields: [{ name: 'phone', required: true }],
  }
}

const groups = [
  {
    sub_service: { id: 7, app_service_id: 1, name: 'Data', created_at: null, updated_at: null },
    products: [
      product(1213, '35GB Monthly Plan (30 Days) - 10,000 Naira', 10000),
      product(1285, '35GB MIFI 10 Data - MiFi Only (30 Days) - 10,000 Naira', 10000),
      product(1261, '18GB Monthly Plan (30 Days) - 6000 Naira', 6000),
    ],
  },
] as unknown as PlanetTalkProductGroup[]

describe('buildOperatorsFromProducts — same-priced products', () => {
  const { operators, productMap } = buildOperatorsFromProducts(groups)
  const op = operators[0]

  it('lists every product separately, ordered by amount then id', () => {
    expect(op.localFixedProducts?.map((p) => p.productId)).toEqual([1261, 1213, 1285])
    expect(op.localFixedProducts?.[2].description).toContain('MiFi Only')
  })

  it('keeps the legacy amount-keyed fields unchanged', () => {
    expect(op.localFixedAmounts).toEqual([6000, 10000, 10000])
  })

  it('resolves an exact product, even when a sibling shares the amount', () => {
    expect(resolveProductId(productMap, op.operatorId, 10000, 1213)?.productId).toBe(1213)
    expect(resolveProductId(productMap, op.operatorId, 10000, 1285)?.productId).toBe(1285)
  })

  it('still resolves by amount when no productId is given', () => {
    expect(resolveProductId(productMap, op.operatorId, 6000)?.productId).toBe(1261)
  })

  it('rejects a productId paired with a different amount or another operator', () => {
    expect(resolveProductId(productMap, op.operatorId, 6000, 1213)).toBeNull()
    expect(resolveProductId(productMap, op.operatorId + 1, 10000, 1213)).toBeNull()
  })
})
