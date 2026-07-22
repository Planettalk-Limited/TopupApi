// Ported verbatim from TopupApp/src/types/fulfillment.ts

export type FulfillmentProductType = 'topup' | 'data' | 'giftcard' | 'utility'

export type FulfillmentProvider = 'reloadly' | 'planettalk'

export type FulfillmentStatus = 'false' | 'processing' | 'true' | 'failed'

export interface FulfillmentOrderBase {
  productType: FulfillmentProductType
  countryCode: string
  providerAmount: number
  providerCurrency: string
  productName?: string
  /**
   * Buyer's email. Required by the buhibab (PlanetTalk/Nigeria) purchase API,
   * which also sends its own confirmation email. Carried through PaymentIntent
   * metadata so it's available at fulfilment time.
   */
  email?: string
}

export interface TopupFulfillmentOrder extends FulfillmentOrderBase {
  productType: 'topup' | 'data'
  operatorId: number
  recipientPhone: string
  useLocalAmount: boolean
  description?: string
}

export interface GiftCardFulfillmentOrder extends FulfillmentOrderBase {
  productType: 'giftcard'
  productId: number
  recipientEmail?: string
}

export interface UtilityFulfillmentOrder extends FulfillmentOrderBase {
  productType: 'utility'
  billerId: number
  accountNumber: string
  phone?: string
  referenceId?: string
}

export type FulfillmentOrder =
  | TopupFulfillmentOrder
  | GiftCardFulfillmentOrder
  | UtilityFulfillmentOrder

export interface FulfillmentTransaction {
  transactionId: string
  operatorTransactionId?: string | null
  status?: string
  deliveryStatus?: string
  amount?: number
  currency?: string
  recipientPhone?: string | { countryCode?: string; number?: string }
  productId?: number
  productName?: string
  billerId?: number
  billerName?: string
  accountNumber?: string
  referenceId?: string
  cardCode?: string
  cardPin?: string
  /**
   * Provider-returned metadata. For buhibab electricity purchases this holds the
   * delivered token + units; null for airtime/data/cable TV (nothing to show).
   */
  meta?: Record<string, unknown> | null
  timestamp: string
  provider: FulfillmentProvider
}

export interface GiftCardRedeemInfo {
  cardCode: string
  cardPin?: string
  redemptionUrl?: string
  isSandboxTest?: boolean
}

export interface FulfillmentResult {
  success: true
  alreadyFulfilled?: boolean
  transaction: FulfillmentTransaction
  giftCard?: GiftCardRedeemInfo
}

export interface FulfillmentFailure {
  success: false
  error: string
  retryable?: boolean
  errorCode?: string
}
