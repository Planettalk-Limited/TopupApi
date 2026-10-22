// The order-preparation + server-pricing path shared by POST /payments/create-intent and
// POST /promo/validate, so a promo quote is computed from exactly the subtotal the
// customer will then be charged against. Extracted verbatim from PaymentsController.
import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { isHealthcareEnabled } from '../common/healthcare-enabled'
import { isVouchersEnabled } from '../common/vouchers-enabled'
import type { HealthcareService } from '../providers/buhibab/healthcare.service'
import type { VoucherService } from '../providers/buhibab/voucher.service'
import { resolveChargeCurrency } from './charge-currency'
import type { FulfillmentOrderDto } from './dto/create-intent.dto'
import { HEALTHCARE_PRODUCT_ID, healthcareProductName, healthcareProviderTotal } from './healthcare-order'
import { validateFulfillmentOrder } from './order-metadata'
import { PricingError, type PricingService } from './pricing.service'
import { voucherProductName } from './voucher-order'
import type {
  FulfillmentOrder,
  HealthcareDetails,
  HealthcareFulfillmentOrder,
  TopupFulfillmentOrder,
  VoucherFulfillmentOrder,
} from './payments.types'

/**
 * Turn the client's pharmacy order into the authoritative one. The client names the
 * medications and quantities; the server looks up every price itself. `providerAmount`
 * from the client is only an echo of what the UI displayed — if it no longer matches, the
 * customer is sent back to review rather than charged a figure they never saw.
 */
export async function buildHealthcareOrder(
  healthcare: HealthcareService,
  input: FulfillmentOrderDto,
): Promise<HealthcareFulfillmentOrder> {
  if (!input.phone?.trim() || !input.patient || !input.drugs?.length) {
    throw new BadRequestException('phone, patient and drugs are required for pharmacy orders')
  }

  let drugs: HealthcareDetails['drugs']
  try {
    drugs = await healthcare.resolveDrugLines(
      input.drugs.map((d) => ({
        drugName: d.drugName,
        quantity: d.quantity,
        ...(d.dose?.trim() ? { dose: d.dose.trim() } : {}),
      })),
    )
  } catch (error) {
    if (error instanceof NotFoundException) {
      throw new UnprocessableEntityException(error.message)
    }
    throw error
  }

  const p = input.patient
  const details: HealthcareDetails = {
    // No pharmacy is chosen (buhibab 2026-10-16): WellaHealth routes the order and
    // delivers it, so there is nowhere to collect from — pickup is not offered.
    isDelivery: true,
    buyerPhone: input.phone.trim(),
    patient: {
      firstName: p.firstName.trim(),
      lastName: p.lastName.trim(),
      gender: p.gender,
      phone: p.phone.trim(),
      ...(p.email?.trim() ? { email: p.email.trim() } : {}),
      address: p.address.trim(),
    },
    drugs,
  }

  const providerAmount = healthcareProviderTotal(details)
  // The global exception filter reduces errors to a message, so the client re-quotes
  // (POST /payments/healthcare/quote) to get the current total rather than reading it here.
  if (Math.abs(providerAmount - input.providerAmount) > 0.01) {
    throw new ConflictException('Medication prices have changed. Please review your order.')
  }

  return {
    productType: 'healthcare',
    countryCode: input.countryCode,
    providerAmount,
    providerCurrency: input.providerCurrency,
    productName: healthcareProductName(details),
    email: input.email?.trim(),
    productId: HEALTHCARE_PRODUCT_ID,
    details,
  }
}

/**
 * Turn the client's voucher order into the authoritative one: the brand must still be in
 * buhibab's catalog, and its name comes from there, not from the client. The amount is
 * checked against the brand's bounds by PricingService.
 */
export async function buildVoucherOrder(
  vouchers: VoucherService,
  input: FulfillmentOrderDto,
): Promise<VoucherFulfillmentOrder> {
  if (!input.productId) {
    throw new BadRequestException('productId is required')
  }
  const voucher = await vouchers.findVoucher(input.productId)
  if (!voucher) {
    throw new UnprocessableEntityException('This gift voucher is no longer available')
  }
  return {
    productType: 'voucher',
    countryCode: input.countryCode,
    providerAmount: input.providerAmount,
    providerCurrency: input.providerCurrency,
    productName: voucherProductName(voucher.name),
    email: input.email?.trim(),
    productId: voucher.id,
    ...(input.recipientEmail?.trim() ? { recipientEmail: input.recipientEmail.trim() } : {}),
  }
}

export interface PricedCheckout {
  order: FulfillmentOrder
  /** Lower-case charge currency, e.g. 'gbp'. */
  currency: string
  /** Server price BEFORE any promo discount — the global £3–£20 band applies to this. */
  subtotal: number
}

/**
 * Validate and normalise the client's order, then price it server-side. Throws the same
 * HTTP errors create-intent always has.
 */
export async function prepareAndPriceOrder(
  deps: { pricing: PricingService; healthcare: HealthcareService; vouchers?: VoucherService },
  input: FulfillmentOrderDto,
  rawCurrency: string | undefined,
): Promise<PricedCheckout> {
  if (input.productType === 'healthcare' && !isHealthcareEnabled()) {
    throw new BadRequestException('Healthcare orders are not available')
  }
  if (input.productType === 'voucher' && (!isVouchersEnabled() || !deps.vouchers)) {
    throw new BadRequestException('Gift vouchers are not available')
  }

  // Healthcare keeps charging in the customer's local currency for now; every other
  // product is limited to the supported display currencies.
  const currency =
    input.productType === 'healthcare' ? (rawCurrency || 'usd').toLowerCase() : resolveChargeCurrency(rawCurrency)
  // NOTE: any client-supplied `amount` is intentionally not accepted anywhere in
  // this DTO. The charge is computed server-side from the order below so it can
  // never be lower than the value delivered to the provider.
  const order: FulfillmentOrder =
    input.productType === 'healthcare'
      ? await buildHealthcareOrder(deps.healthcare, input)
      : input.productType === 'voucher' && deps.vouchers
        ? await buildVoucherOrder(deps.vouchers, input)
        : (input as unknown as FulfillmentOrder)

  const orderError = validateFulfillmentOrder(order)
  if (orderError) {
    throw new BadRequestException(orderError)
  }

  // Normalize once, up front, before pricing/signing/metadata all read this field.
  // If a topup/data order omits `useLocalAmount`, `canonicalize` would sign it as ''
  // but `parseFulfillmentOrder` later coerces the empty metadata value back to `true`
  // — an HMAC mismatch on the webhook's recompute (403 charged-not-delivered). Pricing
  // and the executor already default to `?? true`, so making it explicit here changes
  // no behavior for well-formed orders; it just makes the signed value match reality.
  if (order.productType === 'topup' || order.productType === 'data') {
    ;(order as TopupFulfillmentOrder).useLocalAmount = (order as TopupFulfillmentOrder).useLocalAmount ?? true
  }

  // Server computes the authoritative charge from the order + the provider's real
  // product data (validating limits and denominations). See pricing.service.ts.
  try {
    const subtotal = await deps.pricing.priceOrder(order, currency)
    return { order, currency, subtotal }
  } catch (error) {
    if (error instanceof PricingError) {
      throw new HttpException(error.message, error.statusCode)
    }
    throw error
  }
}
