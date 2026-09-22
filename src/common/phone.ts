/**
 * Recipient phone handling for provider fulfilment.
 *
 * Reloadly's top-up API reads `recipientPhone.number` as the FULL subscriber number
 * INCLUDING the dialling code, and silently prepends the country's dialling code when
 * the value it receives does not already start with one. A number with the dialling
 * code stripped off is therefore not "the national number" to Reloadly — it is a
 * different, usually nonexistent number:
 *
 *   sent "700900000" with countryCode GB -> Reloadly recorded "44700900000"  (invalid)
 *   sent "447700900000" with countryCode GB -> Reloadly recorded "447700900000" (correct)
 *
 * The old executor-local normalizer guessed the dialling code's length with a greedy
 * /^(\d{1,3})(\d{9,10})$/ match, so it removed 3 digits (backtracking to 2) purely on
 * total length. That corrupted every country whose (total - dialling code) length was
 * not coincidentally 9 or 10 — GB, US/CA and the +1 Caribbean, IN, PH, BR, and any
 * NG number typed in trunk-0 national form — and produced live
 * `INVALID_RECIPIENT_PHONE` / "Recipient phone number is not valid" 400s AFTER the
 * customer had been charged.
 *
 * libphonenumber-js carries Google's real per-country metadata, so it is the authority
 * here instead of a length heuristic. It is already installed as a direct dependency of
 * class-validator; it is declared in our own package.json too so this does not rely on
 * a transitive hoist.
 *
 * We use the default ('min') metadata bundle deliberately. It validates that a number is
 * a real, correctly-shaped number for its country — which is what Reloadly checks — but
 * it cannot tell mobile from fixed-line (`getType()` is undefined for many countries).
 * Gating top-ups on "must be MOBILE" would need the much larger /max or /mobile bundle
 * and would reject legitimate numbers in countries with shared ranges; operator
 * resolution already happens separately via Reloadly's /operators/auto-detect at
 * checkout, so number-level validity is the right line to draw here.
 */
import { getCountryCallingCode, parsePhoneNumberFromString, type CountryCode, type PhoneNumber } from 'libphonenumber-js'

/**
 * Parse a recipient phone against its order's ISO-3166 country, accepting every shape
 * the checkout can produce: '+447700900000', '447700900000' (E.164 digits with no '+',
 * which is what our own /operators/auto-detect call already sends), '07700900000'
 * (national with a trunk prefix), and any of those with spaces/dashes/parentheses.
 */
/**
 * An order's `countryCode` is the DESTINATION country: operatorId, pricing and provider
 * routing are all scoped to it, and the executor sends it to Reloadly alongside the
 * number. A number from another country is not deliverable for that order however valid
 * it is on its own, so a mismatch is rejected rather than silently sent.
 *
 * libphonenumber attributes the specific country even inside a shared dialling code
 * (+1 876 -> JM, +1 415 -> US). Where it cannot, we fall back to comparing the dialling
 * code so an unattributable-but-plausible number is not rejected outright.
 */
function belongsTo(parsed: PhoneNumber, expected: CountryCode): boolean {
  if (parsed.country) return parsed.country === expected

  try {
    return parsed.countryCallingCode === getCountryCallingCode(expected)
  } catch {
    return false
  }
}

function parse(raw: string, countryCode: string) {
  if (typeof raw !== 'string' || typeof countryCode !== 'string') return null

  const trimmed = raw.trim()
  if (!trimmed) return null

  const country = countryCode.trim().toUpperCase() as CountryCode
  if (!/^[A-Z]{2}$/.test(country)) return null

  // An explicit '+' fixes which country the number is in, but it must still be the
  // order's country — see belongsTo below.
  if (trimmed.startsWith('+')) {
    const intl = parsePhoneNumberFromString(trimmed)
    return intl?.isValid() && belongsTo(intl, country) ? intl : null
  }

  const digits = trimmed.replace(/[^\d]/g, '')
  if (!digits) return null

  // National first: a trunk-0 or bare national number only resolves with the country
  // hint. Then fall back to reading the digits as E.164 without its '+'. These cannot
  // both match for a real number — a valid national number is always too short to also
  // be a valid dialling-code-prefixed one for the same country.
  const national = parsePhoneNumberFromString(digits, country)
  if (national?.isValid() && belongsTo(national, country)) return national

  const international = parsePhoneNumberFromString(`+${digits}`)
  return international?.isValid() && belongsTo(international, country) ? international : null
}

/**
 * The exact string to put in Reloadly's `recipientPhone.number`: full E.164 digits with
 * no '+'. Returns null when the number is not a valid number for that country — callers
 * must treat null as "do not send this to the provider".
 */
export function toE164Digits(raw: string, countryCode: string): string | null {
  const parsed = parse(raw, countryCode)
  return parsed ? parsed.number.replace(/^\+/, '') : null
}

/** Pre-charge gate: is this a real, dialable number for the order's country? */
export function isValidRecipientPhone(raw: string, countryCode: string): boolean {
  return parse(raw, countryCode) !== null
}
