// Validates the body of POST /api/payments/create-intent: `{ currency?, order }`.
//
// The nested order is deliberately permissive — it declares every field used by any
// of the four fulfillment product types (topup/data/giftcard/utility) as optional so
// the global `ValidationPipe({ forbidNonWhitelisted: true })` doesn't reject a valid
// order, but does still strip/reject genuinely unknown properties. `PricingService`
// (via `validateFulfillmentOrder` + `priceOrder`) remains the real authority on
// whether a given order is actually complete/valid for its product type — this DTO
// only guards types/shape.
import { Type } from 'class-transformer'
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator'
import type { FulfillmentProductType } from '../payments.types'

const PRODUCT_TYPES: FulfillmentProductType[] = ['topup', 'data', 'giftcard', 'utility']

export class FulfillmentOrderDto {
  @IsIn(PRODUCT_TYPES, { message: `productType must be one of ${PRODUCT_TYPES.join(', ')}` })
  productType!: FulfillmentProductType

  @IsString()
  @IsNotEmpty()
  countryCode!: string

  @IsNumber()
  providerAmount!: number

  @IsString()
  @IsNotEmpty()
  providerCurrency!: string

  @IsOptional()
  @IsString()
  @MaxLength(255)
  productName?: string

  // Buyer's email — required by the buhibab (PlanetTalk/Nigeria) purchase path;
  // optional for the other providers. Not strictly IsEmail-validated here since the
  // provider executors are the real consumers and this DTO's job is shape, not policy.
  @IsOptional()
  @IsString()
  @MaxLength(254)
  email?: string

  // --- topup / data ---
  @IsOptional()
  @IsNumber()
  operatorId?: number

  @IsOptional()
  @IsString()
  recipientPhone?: string

  @IsOptional()
  @IsBoolean()
  useLocalAmount?: boolean

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string

  // --- giftcard ---
  @IsOptional()
  @IsNumber()
  productId?: number

  @IsOptional()
  @IsString()
  @MaxLength(254)
  recipientEmail?: string

  // --- utility ---
  @IsOptional()
  @IsNumber()
  billerId?: number

  @IsOptional()
  @IsString()
  accountNumber?: string

  @IsOptional()
  @IsString()
  phone?: string

  @IsOptional()
  @IsString()
  @MaxLength(36)
  referenceId?: string
}

export class CreateIntentDto {
  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string

  @ValidateNested()
  @Type(() => FulfillmentOrderDto)
  order!: FulfillmentOrderDto

  // --- Analytics attribution (advisory only) ---
  // Deliberately siblings of `order`, NOT fields inside it. The order object is
  // canonicalized and HMAC-signed (SignatureService) and re-derived from Stripe metadata
  // on the webhook; a new field inside `order` would change the signed payload and fail
  // the webhook's signature recompute, stranding a charged order as unfulfilled.
  // Nothing here is trusted: it never reaches pricing, signing, or fulfilment, and the
  // controller sanitizes it before persisting.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  gaClientId?: string

  /** Map of GA4 measurement id -> session id. GA4 sessions are property-scoped. */
  @IsOptional()
  @IsObject()
  gaSessions?: Record<string, unknown>
}
