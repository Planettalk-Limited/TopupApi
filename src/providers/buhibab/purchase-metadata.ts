// buhibab's purchase endpoint takes an optional `metadata` array (added 2026-10-16, see
// developers.buhibab.com > Purchases): up to 20 `{ key, value }` items, each value a
// string, boolean or number of at most 255 characters. It is stored on the transaction and
// shown to their team as "Extra data", but never sent to the provider — so it is how
// buhibab support traces one of their transactions back to our Stripe payment and order.

export interface PurchaseMetadataItem {
  key: string
  value: string | number | boolean
}

const MAX_ITEMS = 20
const MAX_LENGTH = 255

export function buildPurchaseMetadata(refs: {
  paymentIntentId?: string
  orderId?: string
}): PurchaseMetadataItem[] {
  const items: PurchaseMetadataItem[] = []
  if (refs.paymentIntentId) items.push({ key: 'stripe_payment_intent', value: refs.paymentIntentId })
  if (refs.orderId) items.push({ key: 'order_id', value: refs.orderId })
  return items
    .slice(0, MAX_ITEMS)
    .map((item) => (typeof item.value === 'string' ? { ...item, value: item.value.slice(0, MAX_LENGTH) } : item))
}

/** Form-data encoding of the array (`metadata[0][key]`, ...), which buhibab (Laravel) parses back into it. */
export function appendPurchaseMetadata(form: FormData, items: PurchaseMetadataItem[]): void {
  items.forEach((item, i) => {
    form.append(`metadata[${i}][key]`, item.key)
    form.append(`metadata[${i}][value]`, String(item.value))
  })
}
