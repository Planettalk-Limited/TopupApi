# Healthcare (pharmacy) — frontend API contract

Nigeria-only. Fulfilled by WellaHealth through buhibab (product `1951`). The customer is
usually abroad and is buying medication for someone ("the beneficiary") in Nigeria.

The customer-facing text in this flow is still placeholder copy; the client will supply the final wording.

## Flow

All paths are under the API's global `/api` prefix.

There is no pharmacy or location step. Since 2026-10-16 an order names no pharmacy:
WellaHealth routes it to a pharmacy near `patient.address` and delivers it there.

```
1. GET  /api/planettalk/healthcare/drugs/search?query=paracetamol   (min 4 chars)
         -> [{ drugName, genericName, brandName, drugClass, dosageForm, strength, packSize,
               price, currency: "NGN" }]                       price = NGN per pack
2. POST /api/payments/healthcare/quote
         { currency: "gbp", drugs: [{ drugName, quantity }] }
         -> { lines: [{ drugName, quantity, unitPrice, lineTotal }], providerAmount,
              providerCurrency: "NGN", amount, currency, payable, message? }
3. POST /api/payments/create-intent   (body below)              -> { clientSecret, paymentIntentId, amount, currency }
4. Stripe Payment Element confirm with clientSecret, then poll
   GET  /api/payments/verify?paymentIntentId=...                -> orderStatus / fulfillmentStatus
```

## create-intent body

```json
{
  "currency": "gbp",
  "order": {
    "productType": "healthcare",
    "countryCode": "NG",
    "providerCurrency": "NGN",
    "providerAmount": 1824,
    "email": "buyer@example.com",
    "phone": "+447700900000",
    "isDelivery": true,
    "patient": {
      "firstName": "Ada",
      "lastName": "Obi",
      "gender": "Female",
      "phone": "08012345678",
      "email": "ada@example.com",
      "address": "1 Allen Avenue, Ikeja, Lagos"
    },
    "drugs": [
      { "drugName": "EMZOR PARACETAMOL SYRUP 60ML", "quantity": 2, "dose": "5ml three times daily" }
    ]
  }
}
```

| Field | Notes |
|---|---|
| `email`, `phone` | The **buyer's** details. The receipt goes to `email`. `phone` can be any international number. |
| `providerAmount` | Echo `providerAmount` from the quote. If prices have changed since, the API returns **409**. Call `quote` again and show the customer the new total. |
| `isDelivery` | Always treated as `true`: the order is delivered to `patient.address`. There is no pickup, because no pharmacy is chosen. |
| `patient` | The **beneficiary**. `gender` must be exactly `"Male"` or `"Female"` (the provider requires it). `phone` must be a valid Nigerian number. `email` is optional. |
| `drugs` | 1–5 lines. `quantity` is a whole number from 1 to 10 and counts **packs**. `dose` is optional and defaults to "As directed". Each `drugName` may appear only once. **Do not send a price.** The server looks every price up itself and rejects any price field. |

## Errors worth handling in the UI

| Status | When |
|---|---|
| 400 | Missing or invalid fields, or a beneficiary phone that isn't Nigerian. |
| 409 | `create-intent`: the total has changed. Re-quote. |
| 422 | A medication is no longer listed (in either `quote` or `create-intent`). Remove it. |
| 503 | buhibab is unreachable. Retry later. |

The quote's `payable: false` means the basket is below the card minimum for the
currency. Ask the customer to add items.

## What happens after payment

Same model as every other product. The card is **authorised, not charged**. When
buhibab accepts the pharmacy order, the payment is captured and the buyer receives the
PlanetTalk receipt. If the order is refused, for example because the pharmacy rejects
it or a price went up after checkout, the authorisation is released and the customer
is never charged.

## Privacy

Beneficiary and medication details never go to Stripe. They are stored in
`orders.details`, and Stripe carries only a SHA-256 of them, which the fulfilment
signature also covers. Stripe sees the product name as "Pharmacy order".

## Provider notes (verified 2026-10-03; docs at developers.buhibab.com)

- `GET /healthcare/drugs/search?query=` needs at least 4 characters. Drug records have no id, so the exact `drugName` is the key.
- `POST /products/1951/purchase` takes JSON: `email`, `phone`, `isDelivery`,
  `fulfilmentService` (`Acute`), `patient{first_name,last_name,gender,phone,address,email?}`,
  `drugs[{name,unitPrice,quantity,dose}]` and `metadata` (see below). A failed order returns
  400 with `data.status: "failed"`. `pharmacyCode` was dropped on 2026-10-16.
- Every buhibab purchase (all products, not just pharmacy) carries
  `metadata: [{ key: "stripe_payment_intent", value }, { key: "order_id", value }]`, so buhibab
  support can trace a transaction back to our Stripe payment and order.
