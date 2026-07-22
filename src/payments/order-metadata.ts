// Ported verbatim from TopupApp/src/lib/fulfillment/metadata.ts
// EXCEPT resolveProvider: the frontend version delegates to the client-side
// `topup-provider` module, which does not exist on the backend. Here the same
// rule is inlined directly against process.env per the task-4 brief.
import type {
  FulfillmentOrder,
  FulfillmentProductType,
  FulfillmentProvider,
  FulfillmentTransaction,
  GiftCardFulfillmentOrder,
  TopupFulfillmentOrder,
  UtilityFulfillmentOrder,
} from './payments.types'

const META = {
  source: 'planettalk-topup',
  fulfilled: 'fulfilled',
  processingAt: 'processingAt',
  providerTransactionId: 'providerTransactionId',
  fulfillmentError: 'fulfillmentError',
  disputed: 'disputed',
  refunded: 'refunded',
  productType: 'productType',
  provider: 'provider',
  countryCode: 'countryCode',
  providerAmount: 'providerAmount',
  providerCurrency: 'providerCurrency',
  productName: 'productName',
  email: 'email',
  operatorId: 'operatorId',
  recipientPhone: 'recipientPhone',
  useLocalAmount: 'useLocalAmount',
  description: 'description',
  productId: 'productId',
  recipientEmail: 'recipientEmail',
  billerId: 'billerId',
  accountNumber: 'accountNumber',
  phone: 'phone',
  referenceId: 'referenceId',
} as const

function str(value: string | number | boolean | undefined | null): string {
  if (value === undefined || value === null) return ''
  return String(value)
}

export function resolveProvider(countryCode: string, productType: FulfillmentProductType): FulfillmentProvider {
  if (productType === 'giftcard') return 'reloadly'
  if (countryCode?.toUpperCase() === 'NG' && process.env.TOPUP_PROVIDER_NG === 'planettalk') return 'planettalk'
  return 'reloadly'
}

export function validateFulfillmentOrder(order: FulfillmentOrder): string | null {
  if (!order.countryCode?.trim()) return 'countryCode is required'
  if (!order.providerAmount || order.providerAmount <= 0) return 'providerAmount must be positive'
  if (!order.providerCurrency?.trim()) return 'providerCurrency is required'

  switch (order.productType) {
    case 'topup':
    case 'data':
      if (!order.operatorId) return 'operatorId is required'
      if (!order.recipientPhone?.trim()) return 'recipientPhone is required'
      return null
    case 'giftcard':
      if (!order.productId) return 'productId is required'
      return null
    case 'utility':
      if (!order.billerId) return 'billerId is required'
      if (!order.accountNumber?.trim()) return 'accountNumber is required'
      return null
    default:
      return 'Invalid product type'
  }
}

export function buildFulfillmentMetadata(
  order: FulfillmentOrder
): Record<string, string> {
  const provider = resolveProvider(order.countryCode, order.productType)
  const base: Record<string, string> = {
    source: META.source,
    [META.fulfilled]: 'false',
    [META.productType]: order.productType,
    [META.provider]: provider,
    [META.countryCode]: order.countryCode.toUpperCase(),
    [META.providerAmount]: str(order.providerAmount),
    [META.providerCurrency]: order.providerCurrency.toUpperCase(),
    [META.productName]: str(order.productName),
    [META.email]: str(order.email),
  }

  switch (order.productType) {
    case 'topup':
    case 'data':
      return {
        ...base,
        [META.operatorId]: str(order.operatorId),
        [META.recipientPhone]: order.recipientPhone,
        [META.useLocalAmount]: str(order.useLocalAmount),
        [META.description]: str(order.description),
      }
    case 'giftcard':
      return {
        ...base,
        [META.productId]: str(order.productId),
        [META.recipientEmail]: str(order.recipientEmail),
      }
    case 'utility': {
      const referenceId =
        order.referenceId ||
        `UTL-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`.substring(0, 36)
      return {
        ...base,
        [META.billerId]: str(order.billerId),
        [META.accountNumber]: order.accountNumber,
        [META.phone]: str(order.phone),
        [META.referenceId]: referenceId,
      }
    }
    default:
      return base
  }
}

export function parseFulfillmentOrder(metadata: Record<string, string>): FulfillmentOrder {
  const productType = metadata[META.productType] as FulfillmentProductType
  const countryCode = metadata[META.countryCode] || ''
  const providerAmount = parseFloat(metadata[META.providerAmount] || '0')
  const providerCurrency = metadata[META.providerCurrency] || 'USD'
  const productName = metadata[META.productName] || undefined
  const email = metadata[META.email] || undefined

  const base = { countryCode, providerAmount, providerCurrency, productName, email }

  switch (productType) {
    case 'topup':
    case 'data':
      return {
        ...base,
        productType,
        operatorId: parseInt(metadata[META.operatorId] || '0', 10),
        recipientPhone: metadata[META.recipientPhone] || '',
        useLocalAmount: metadata[META.useLocalAmount] !== 'false',
        description: metadata[META.description] || undefined,
      } satisfies TopupFulfillmentOrder
    case 'giftcard':
      return {
        ...base,
        productType: 'giftcard',
        productId: parseInt(metadata[META.productId] || '0', 10),
        recipientEmail: metadata[META.recipientEmail] || undefined,
      } satisfies GiftCardFulfillmentOrder
    case 'utility':
      return {
        ...base,
        productType: 'utility',
        billerId: parseInt(metadata[META.billerId] || '0', 10),
        accountNumber: metadata[META.accountNumber] || '',
        phone: metadata[META.phone] || undefined,
        referenceId: metadata[META.referenceId] || undefined,
      } satisfies UtilityFulfillmentOrder
    default:
      throw new Error(`Unknown product type in payment metadata: ${productType}`)
  }
}

export function buildCachedTransaction(
  metadata: Record<string, string>
): FulfillmentTransaction {
  const order = parseFulfillmentOrder(metadata)
  const provider = (metadata[META.provider] as FulfillmentProvider) || resolveProvider(order.countryCode, order.productType)

  return {
    transactionId: metadata[META.providerTransactionId] || '',
    amount: order.providerAmount,
    currency: order.providerCurrency,
    productName: order.productName,
    timestamp: new Date().toISOString(),
    provider,
    ...(order.productType === 'utility'
      ? {
          billerId: order.billerId,
          accountNumber: order.accountNumber,
        }
      : {}),
    ...(order.productType === 'giftcard'
      ? { productId: order.productId }
      : {}),
    ...(order.productType === 'topup' || order.productType === 'data'
      ? { recipientPhone: order.recipientPhone }
      : {}),
  }
}

export { META as FULFILLMENT_META }
