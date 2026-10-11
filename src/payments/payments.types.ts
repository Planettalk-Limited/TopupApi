// Ported verbatim from TopupApp/src/types/fulfillment.ts

export type FulfillmentProductType = 'topup' | 'data' | 'giftcard' | 'utility' | 'healthcare'

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
  /**
   * PlanetTalk (NG) data only: the exact buhibab product to buy. Needed because distinct
   * products can share an operator and a price (e.g. Airtel 35GB vs 35GB MiFi-only), so
   * operatorId + amount alone is ambiguous. Absent for Reloadly and for legacy orders.
   */
  productId?: number
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

export type HealthcareGender = 'Male' | 'Female'

/** The person the medication is for — buhibab's `patient` object. */
export interface HealthcarePatient {
  firstName: string
  lastName: string
  gender: HealthcareGender
  /** Nigerian number; the pharmacy contacts the beneficiary on this. */
  phone: string
  email?: string
  /** Full delivery address. */
  address: string
}

/**
 * One medication line. `unitPrice` is NGN per pack and is ALWAYS set server-side from
 * the provider's drug search (see HealthcareService.resolveDrugLines) — never taken
 * from the client.
 */
export interface HealthcareDrugLine {
  drugName: string
  quantity: number
  unitPrice: number
  dose?: string
}

/**
 * Everything about a pharmacy order that is too large or too sensitive (medical PII) for
 * Stripe metadata. Persisted on `orders.details`; Stripe carries only its SHA-256 hash,
 * which the HMAC binding signature also covers — so the row cannot be edited between
 * checkout and fulfilment without fulfilment refusing it.
 */
export interface HealthcareDetails {
  pharmacyCode: string
  isDelivery: boolean
  /** Buyer's own phone (may be non-Nigerian — the diaspora buys for family at home). */
  buyerPhone: string
  patient: HealthcarePatient
  drugs: HealthcareDrugLine[]
}

export interface HealthcareFulfillmentOrder extends FulfillmentOrderBase {
  productType: 'healthcare'
  /** buhibab product id of the WellaHealth pharmacy product. */
  productId: number
  /**
   * Absent only on an order freshly parsed from Stripe metadata, before the fulfilment
   * service hydrates it from the order row (`hydrateHealthcareOrder`).
   */
  details?: HealthcareDetails
  /** SHA-256 of the canonical details, carried in Stripe metadata. */
  detailsHash?: string
}

export type FulfillmentOrder =
  | TopupFulfillmentOrder
  | GiftCardFulfillmentOrder
  | UtilityFulfillmentOrder
  | HealthcareFulfillmentOrder

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
