import { Injectable } from '@nestjs/common'
import { PlanetTalkService } from '../../providers/buhibab/planettalk.service'
import { getPlanetTalkUrl } from '../../providers/buhibab/planettalk.config'
import { toE164Digits } from '../../common/phone'
import { HEALTHCARE_DEFAULT_DOSE } from '../healthcare-order'
import type { FulfillmentTransaction, HealthcareFulfillmentOrder } from '../payments.types'

type ExecutorError = Error & { retryable?: boolean; statusCode?: number }

function executorError(message: string, opts: { retryable: boolean; statusCode?: number }): ExecutorError {
  const err = new Error(message) as ExecutorError
  err.retryable = opts.retryable
  if (opts.statusCode !== undefined) err.statusCode = opts.statusCode
  return err
}

/** `0XXXXXXXXXX` — the local format buhibab expects (see the other planettalk executors). */
function toNigerianLocal(raw: string): string {
  const e164 = toE164Digits(raw, 'NG')
  return e164 ? `0${e164.slice(3)}` : raw
}

/**
 * Places a WellaHealth pharmacy order via buhibab: `POST /products/{id}/purchase` with a
 * JSON body. The payload contract is undocumented upstream; it was established from the
 * live API's validation errors on 2026-10-03:
 *   - required: email, pharmacyCode, drugs[].name, drugs[].unitPrice, drugs[].dose (or
 *     strength+frequency+duration), patient.{first_name,last_name,address,gender,phone}
 *   - patient.gender is exactly "Male" | "Female"; drugs[].quantity must be numeric
 *   - a failed order comes back as 400 with `data.status: "failed"`
 *
 * buhibab exposes no client reference field for this product, so double-submission is
 * guarded only by FulfillmentService's row claim — the same as every other executor.
 */
@Injectable()
export class PlanetTalkHealthcareExecutor {
  constructor(private readonly planetTalk: PlanetTalkService) {}

  async execute(order: HealthcareFulfillmentOrder, _paymentIntentId: string): Promise<FulfillmentTransaction> {
    if (!this.planetTalk.hasCredentials()) {
      throw new Error('Planet Talk API credentials not configured')
    }
    const details = order.details
    if (!details) {
      throw executorError('Healthcare order details are missing', { retryable: false })
    }

    const patientPhone = toNigerianLocal(details.patient.phone)
    const payload = {
      email: order.email,
      // The beneficiary's number, not the buyer's: buhibab files it as the receiver phone
      // and the buyer may be abroad on a number the pharmacy cannot use.
      phone: patientPhone,
      pharmacyCode: details.pharmacyCode,
      isDelivery: details.isDelivery,
      fulfilmentService: 'Acute',
      patient: {
        first_name: details.patient.firstName,
        last_name: details.patient.lastName,
        gender: details.patient.gender,
        phone: patientPhone,
        address: details.patient.address,
        ...(details.patient.email ? { email: details.patient.email } : {}),
      },
      drugs: details.drugs.map((d) => ({
        name: d.drugName,
        unitPrice: d.unitPrice,
        quantity: d.quantity,
        dose: d.dose?.trim() || HEALTHCARE_DEFAULT_DOSE,
      })),
    }

    let res: Response
    try {
      res = await this.planetTalk.fetch(`${getPlanetTalkUrl()}/products/${order.productId}/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch (networkErr) {
      throw executorError(
        networkErr instanceof Error ? networkErr.message : 'Network error calling Planet Talk',
        { retryable: true },
      )
    }

    const body = (await res.json().catch(() => ({}))) as {
      message?: string
      data?: { id?: number | string; amount?: number; status?: string; reference?: string; meta?: unknown }
    }

    if (!res.ok) {
      throw executorError(body.message || 'Failed to place the pharmacy order', {
        retryable: res.status >= 500,
        statusCode: res.status,
      })
    }

    // Defensive: a 2xx whose transaction row still says failed is not a placed order.
    if (body.data?.status === 'failed') {
      throw executorError(body.message || 'The pharmacy order was not accepted', {
        retryable: false,
        statusCode: 400,
      })
    }

    return {
      transactionId: String(body.data?.id ?? Date.now()),
      productId: order.productId,
      productName: order.productName,
      amount: body.data?.amount ?? order.providerAmount,
      currency: 'NGN',
      status: body.data?.status === 'completed' ? 'SUCCESSFUL' : body.data?.status?.toUpperCase(),
      referenceId: body.data?.reference,
      meta: {
        pharmacyCode: details.pharmacyCode,
        isDelivery: details.isDelivery,
        providerStatus: body.data?.status ?? null,
        ...(body.data?.meta && typeof body.data.meta === 'object' ? { provider: body.data.meta } : {}),
      },
      timestamp: new Date().toISOString(),
      provider: 'planettalk',
    }
  }
}
