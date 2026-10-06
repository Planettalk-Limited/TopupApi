// Ported verbatim from TopupApp src/lib/planettalk-billers.ts and
// planettalk-products.ts. These are PURE functions and the mapping logic
// (stableId, productMap keys, resolveProductId, fx-rate derivation) MUST stay
// identical — the Phase 4 fulfillment path keys off the exact product IDs and
// map keys produced here.

import { getNgOperatorMeta, subServiceToBillerType } from './ng-operators'
import type { PlanetTalkProduct, PlanetTalkProductGroup } from './planettalk.types'

// ---------------------------------------------------------------------------
// Utility billers (Electricity / Internet / Cable TV)
// ---------------------------------------------------------------------------

export interface MappedBiller {
  id: number
  name: string
  type: string
  serviceType: string
  countryCode: string
  localAmountSupported: boolean
  internationalAmountSupported: boolean
  localTransactionCurrencyCode: string
  senderCurrencyCode: string
  fx: { rate: number; currencyCode: string }
  logoUrls: string[]
  minLocalTransactionAmount: number | null
  maxLocalTransactionAmount: number | null
  localMinAmount: number | null
  localMaxAmount: number | null
  minAmount: number | null
  maxAmount: number | null
  localFixedAmounts: number[]
  localFixedAmountsDescriptions: Record<string, string>
  _requiresPhone: boolean
  _additionalFields: { name: string; required: boolean; label: string; description: string }[]
  _fixedPrice: boolean
  _accountLabel: string
  _accountPlaceholder: string
  _phoneLabel: string
}

const UTILITY_SUB_SERVICES = new Set(['Electricity', 'Internet', 'Cable TV'])

export function buildBillersFromProducts(productGroups: PlanetTalkProductGroup[]): MappedBiller[] {
  const billers: MappedBiller[] = []

  for (const group of productGroups) {
    if (!UTILITY_SUB_SERVICES.has(group.sub_service.name)) continue

    const billerType = subServiceToBillerType(group.sub_service.name)

    for (const product of group.products) {
      const meta = getNgOperatorMeta(product.operator_name)
      const fxRate = product.price > 0 ? product.value_amount / product.price : 1

      const fieldNames = product.additional_fields.map((f) => f.name)
      const requiresPhone = fieldNames.includes('phone')

      const isVariable = !product.fixed_price
      const minLocal = isVariable ? product.value_amount : product.value_amount
      const maxLocal = isVariable
        ? (product.value_amount_max ?? product.value_amount)
        : product.value_amount

      const localFixedAmounts = product.fixed_price ? [product.value_amount] : []
      const localFixedAmountsDescriptions: Record<string, string> = product.fixed_price
        ? { [String(product.value_amount)]: product.name }
        : {}

      billers.push({
        id: product.id,
        name: product.name,
        type: billerType,
        serviceType: isVariable ? 'Prepaid' : 'Prepaid',
        countryCode: 'NG',
        localAmountSupported: true,
        internationalAmountSupported: false,
        localTransactionCurrencyCode: 'NGN',
        senderCurrencyCode: 'USD',
        fx: { rate: fxRate, currencyCode: 'NGN' },
        logoUrls: product.operator_logo ? [product.operator_logo] : meta.logo ? [meta.logo] : [],
        minLocalTransactionAmount: minLocal,
        maxLocalTransactionAmount: maxLocal,
        localMinAmount: minLocal,
        localMaxAmount: maxLocal,
        minAmount: Math.round((minLocal / fxRate) * 100) / 100,
        maxAmount: Math.round((maxLocal / fxRate) * 100) / 100,
        localFixedAmounts,
        localFixedAmountsDescriptions,
        _requiresPhone: requiresPhone,
        _additionalFields: product.additional_fields.map((f) => ({
          name: f.name,
          required: f.required,
          label: f.label,
          description: f.description,
        })),
        _fixedPrice: product.fixed_price,
        _accountLabel:
          product.additional_fields.find((f) => f.name === 'billersCode')?.label || 'Account Number',
        _accountPlaceholder:
          product.additional_fields.find((f) => f.name === 'billersCode')?.description ||
          'Enter your account or meter number',
        _phoneLabel: product.additional_fields.find((f) => f.name === 'phone')?.label || 'Phone Number',
      })
    }
  }

  return billers
}

// ---------------------------------------------------------------------------
// Airtime / Data operators
// ---------------------------------------------------------------------------

export interface MappedOperator {
  operatorId: number
  name: string
  bundle: boolean
  data: boolean
  pin: boolean
  supportsLocalAmounts: boolean
  logoUrls: string[]
  fixedAmounts: number[]
  fixedAmountsDescriptions: Record<string, string>
  localFixedAmounts: number[]
  localFixedAmountsDescriptions: Record<string, string>
  /**
   * One entry per fixed-price product. `localFixedAmounts` / `...Descriptions` are keyed by
   * amount, so two products with the same price (e.g. Airtel 35GB vs 35GB MiFi-only, both
   * NGN 10,000) collapse into one; this list keeps them distinct and carries the product id
   * the order must be fulfilled with.
   */
  localFixedProducts?: LocalFixedProduct[]
  fx: { rate: number; currencyCode: string }
  senderCurrencyCode: string
  destinationCurrencyCode: string
  minAmount: number | null
  maxAmount: number | null
  localMinAmount: number | null
  localMaxAmount: number | null
  internationalDiscount: number
  mostPopularAmount: number | null
  mostPopularLocalAmount: number | null
}

export interface LocalFixedProduct {
  productId: number
  amount: number
  description: string
}

export interface ProductMapping {
  productId: number
  productName: string
  fixedPrice: boolean
  /** Local (NGN) value of a fixed-price product; used to bind an order's productId to its amount. */
  valueAmount?: number
  additionalFields: { name: string; required: boolean }[]
}

export interface BuildResult {
  operators: MappedOperator[]
  /** Key: `${operatorId}_${localAmount}` for fixed, `${operatorId}_var` for variable */
  productMap: Record<string, ProductMapping>
}

function stableId(subServiceId: number, operatorName: string): number {
  let hash = 0
  for (let i = 0; i < operatorName.length; i++) {
    hash = (hash << 5) - hash + operatorName.charCodeAt(i)
    hash |= 0
  }
  return subServiceId * 100_000 + (Math.abs(hash) % 100_000)
}

function groupByOperator(products: PlanetTalkProduct[]): Record<string, PlanetTalkProduct[]> {
  const groups: Record<string, PlanetTalkProduct[]> = {}
  for (const p of products) {
    const key = p.operator_name
    if (!groups[key]) groups[key] = []
    groups[key].push(p)
  }
  return groups
}

function averageFxRate(products: PlanetTalkProduct[]): number {
  if (products.length === 0) return 1
  const sum = products.reduce((acc, p) => acc + p.value_amount / p.price, 0)
  return sum / products.length
}

export function buildOperatorsFromProducts(productGroups: PlanetTalkProductGroup[]): BuildResult {
  const operators: MappedOperator[] = []
  const productMap: Record<string, ProductMapping> = {}

  for (const group of productGroups) {
    const subName = group.sub_service.name
    const isData = subName === 'Data'

    if (subName !== 'Airtime' && subName !== 'Data') continue

    const byOp = groupByOperator(group.products)

    for (const [opName, products] of Object.entries(byOp)) {
      const opId = stableId(group.sub_service.id, opName)
      const fxRate = averageFxRate(products)
      const meta = getNgOperatorMeta(opName)
      const apiLogo = products.find((p) => p.operator_logo)?.operator_logo

      const fixed = products.filter((p) => p.fixed_price)
      const variable = products.filter((p) => !p.fixed_price)

      const localFixedAmounts = fixed.map((p) => p.value_amount).sort((a, b) => a - b)

      const localFixedDesc: Record<string, string> = {}
      const senderFixedAmounts: number[] = []
      const senderFixedDesc: Record<string, string> = {}

      const localFixedProducts: LocalFixedProduct[] = []

      for (const p of fixed) {
        localFixedDesc[String(p.value_amount)] = p.name
        const senderAmt = Math.round((p.value_amount / fxRate) * 100) / 100
        senderFixedAmounts.push(senderAmt)
        senderFixedDesc[String(senderAmt)] = p.name
        localFixedProducts.push({ productId: p.id, amount: p.value_amount, description: p.name })

        const mapping: ProductMapping = {
          productId: p.id,
          productName: p.name,
          fixedPrice: true,
          valueAmount: p.value_amount,
          additionalFields: p.additional_fields.map((f) => ({ name: f.name, required: f.required })),
        }
        // Amount key: legacy lookup for orders without a productId (last product wins on a
        // shared amount, as before). Product key: exact lookup for orders that carry one.
        productMap[`${opId}_${p.value_amount}`] = mapping
        productMap[`${opId}_p${p.id}`] = mapping
      }

      localFixedProducts.sort((a, b) => a.amount - b.amount || a.productId - b.productId)

      let localMin: number | null = null
      let localMax: number | null = null

      for (const p of variable) {
        const lo = p.value_amount
        const hi = p.value_amount_max ?? p.value_amount
        localMin = localMin == null ? lo : Math.min(localMin, lo)
        localMax = localMax == null ? hi : Math.max(localMax, hi)

        productMap[`${opId}_var`] = {
          productId: p.id,
          productName: p.name,
          fixedPrice: false,
          additionalFields: p.additional_fields.map((f) => ({ name: f.name, required: f.required })),
        }
      }

      operators.push({
        operatorId: opId,
        name: isData ? `${opName} Data` : opName,
        bundle: isData,
        data: isData,
        pin: false,
        supportsLocalAmounts: true,
        logoUrls: apiLogo ? [apiLogo] : meta.logo ? [meta.logo] : [],
        localFixedAmounts,
        localFixedAmountsDescriptions: localFixedDesc,
        localFixedProducts,
        fixedAmounts: senderFixedAmounts,
        fixedAmountsDescriptions: senderFixedDesc,
        fx: { rate: fxRate, currencyCode: 'NGN' },
        senderCurrencyCode: 'USD',
        destinationCurrencyCode: 'NGN',
        localMinAmount: localMin,
        localMaxAmount: localMax,
        minAmount: localMin != null ? Math.round((localMin / fxRate) * 100) / 100 : null,
        maxAmount: localMax != null ? Math.round((localMax / fxRate) * 100) / 100 : null,
        internationalDiscount: 0,
        mostPopularAmount: null,
        mostPopularLocalAmount:
          localFixedAmounts.length > 0
            ? localFixedAmounts[Math.floor(localFixedAmounts.length / 2)]
            : null,
      })
    }
  }

  return { operators, productMap }
}

export function resolveProductId(
  productMap: Record<string, ProductMapping>,
  operatorId: number,
  localAmount: number,
  productId?: number,
): ProductMapping | null {
  if (productId) {
    // An order that names its product gets exactly that product — never a same-priced
    // sibling — and only if it belongs to this operator and matches the paid amount.
    const exact = productMap[`${operatorId}_p${productId}`]
    if (!exact || exact.valueAmount === undefined || Math.abs(exact.valueAmount - localAmount) >= 0.01) {
      return null
    }
    return exact
  }
  return productMap[`${operatorId}_${localAmount}`] ?? productMap[`${operatorId}_var`] ?? null
}
