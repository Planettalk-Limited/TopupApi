// Ported verbatim from TopupApp/src/lib/currency.ts (convertCurrency + fallbackRates)
// and TopupApp/src/lib/stripe-limits.ts (getStripeLimits, validateStripeAmount,
// toStripeAmount, fromStripeAmount, formatStripeCurrency).
// This is the source of charged prices and must match the frontend exactly — no logic changes.

/**
 * Convert currency synchronously using fallback rates (client-side)
 * For production: Fetch rates from your backend API on page load
 */
export function convertCurrency(
  amount: number,
  fromCurrency: string,
  toCurrency: string
): number {
  if (fromCurrency === toCurrency) return amount

  // Fallback rates - these are approximate and should be updated from API
  const fallbackRates: { [key: string]: number } = {
    USD: 1,
    EUR: 0.92,
    GBP: 0.79,
    JPY: 148,
    CNY: 7.2,
    INR: 83,
    CAD: 1.36,
    AUD: 1.52,
    CHF: 0.88,
    MXN: 17,
    BRL: 5,
    ZAR: 18.5,
    RUB: 90,
    KRW: 1320,
    SGD: 1.34,
    HKD: 7.8,
    NOK: 10.5,
    SEK: 10.4,
    NZD: 1.61,
    TRY: 32,
    PLN: 4,
    THB: 35,
    IDR: 15700,
    MYR: 4.7,
    PHP: 56,
    DKK: 6.9,
    CZK: 22.5,
    HUF: 360,
    ILS: 3.6,
    CLP: 950,
    ARS: 850,
    COP: 4000,
    EGP: 49,
    PKR: 278,
    NGN: 1550,
    VND: 24500,
    UAH: 38,
    MAD: 10,
    SAR: 3.75,
    AED: 3.67,
    KES: 150,
    GHS: 12,
    // East Africa (utilities) - approximate per 1 USD
    UGX: 3800,
    TZS: 2600,
    RWF: 1300,
    BIF: 2850,
    ETB: 56,
    MWK: 1700,
    ZMW: 27,
    MZN: 64,
    AOA: 830,
    MUR: 46,
    // Central America & Caribbean
    GTQ: 7.8,
    HNL: 24.7,
    NIO: 36.7,
    CRC: 530,
    PAB: 1,
    DOP: 58,
    JMD: 155,
    TTD: 6.8,
    BBD: 2,
    BSD: 1,
    // South America (additional)
    PEN: 3.7,
    UYU: 39,
    PYG: 7300,
    BOB: 6.9,
    VES: 36,
    // Europe (additional)
    ISK: 138,
    RON: 4.6,
    BGN: 1.8,
    HRK: 6.9,
    RSD: 108,
    MKD: 56,
    ALL: 93,
    BAM: 1.8,
    MDL: 17.7,
    // Asia (additional)
    TWD: 31.5,
    MOP: 8.05,
    MMK: 2100,
    KHR: 4100,
    LAK: 21000,
    BND: 1.34,
    BDT: 110,
    LKR: 305,
    NPR: 133,
    BTN: 83,
    MVR: 15.4,
    AFN: 71,
    // Middle East (additional)
    QAR: 3.64,
    KWD: 0.31,
    BHD: 0.38,
    OMR: 0.38,
    JOD: 0.71,
    IQD: 1310,
    LBP: 89500,
    SYP: 13000,
    YER: 250,
    // Africa (additional)
    TND: 3.1,
    DZD: 135,
    LYD: 4.8,
    XOF: 610,    // West African CFA Franc
    XAF: 610,    // Central African CFA Franc
    GMD: 63,
    SLL: 20000,
    LRD: 186,
    SOS: 571,
    SDG: 601,
    BWP: 13.5,
    NAD: 18.5,
    SZL: 18.5,
    LSL: 18.5,
    MGA: 4500,
    SCR: 14,
    // Oceania (additional)
    FJD: 2.25,
    PGK: 3.7,
    TOP: 2.35,
    WST: 2.7,
    VUV: 119,
    SBD: 8.5,
    XPF: 111,    // CFP Franc
    // Central Asia (additional)
    KZT: 450,
    UZS: 12500,
    TJS: 10.9,
    KGS: 89,
    TMT: 3.5,
    AZN: 1.7,
    GEL: 2.7,
    AMD: 390,
  }

  const fromKey = fromCurrency.toUpperCase()
  const toKey = toCurrency.toUpperCase()

  if (!(fromKey in fallbackRates)) {
    console.warn(`[convertCurrency] No exchange rate for ${fromKey}, treating as USD`)
    fallbackRates[fromKey] = 1
  }

  if (!(toKey in fallbackRates)) {
    console.warn(`[convertCurrency] No exchange rate for ${toKey}, treating as USD`)
    fallbackRates[toKey] = 1
  }

  const fromRate = fallbackRates[fromKey]
  const toRate = fallbackRates[toKey]
  const convertedAmount = (amount / fromRate) * toRate
  const result = Math.round(convertedAmount * 100) / 100
  return result
}

// Dynamic Stripe minimum and maximum amounts by currency
// Based on Stripe's official documentation: https://stripe.com/docs/currencies#minimum-and-maximum-charge-amounts

export interface StripeLimits {
  minimum: number // in major currency units (e.g., dollars, not cents)
  maximum: number
  currency: string
  decimals: number // number of decimal places
}

/**
 * Get Stripe's minimum and maximum charge amounts for a currency
 * This is based on Stripe's actual limits per currency
 */
export function getStripeLimits(currency: string): StripeLimits {
  const curr = currency.toUpperCase()

  // Zero-decimal currencies (no cents/paise)
  const zeroDecimalCurrencies: { [key: string]: StripeLimits } = {
    JPY: { minimum: 50, maximum: 9999999, currency: 'JPY', decimals: 0 },
    KRW: { minimum: 50, maximum: 9999999, currency: 'KRW', decimals: 0 },
    VND: { minimum: 10000, maximum: 9999999, currency: 'VND', decimals: 0 },
    CLP: { minimum: 50, maximum: 9999999, currency: 'CLP', decimals: 0 },
    ISK: { minimum: 50, maximum: 9999999, currency: 'ISK', decimals: 0 },
    UGX: { minimum: 1000, maximum: 9999999, currency: 'UGX', decimals: 0 },
  }

  if (zeroDecimalCurrencies[curr]) {
    return zeroDecimalCurrencies[curr]
  }

  // Two-decimal currencies with specific minimums (comprehensive global coverage)
  const specificLimits: { [key: string]: StripeLimits } = {
    // ===== MAJOR GLOBAL CURRENCIES =====
    USD: { minimum: 0.50, maximum: 999999.99, currency: 'USD', decimals: 2 },
    EUR: { minimum: 0.50, maximum: 999999.99, currency: 'EUR', decimals: 2 },
    GBP: { minimum: 0.30, maximum: 999999.99, currency: 'GBP', decimals: 2 },

    // ===== NORTH AMERICA =====
    CAD: { minimum: 0.50, maximum: 999999.99, currency: 'CAD', decimals: 2 },
    MXN: { minimum: 10.00, maximum: 999999.99, currency: 'MXN', decimals: 2 },

    // ===== SOUTH AMERICA =====
    BRL: { minimum: 0.50, maximum: 999999.99, currency: 'BRL', decimals: 2 },
    ARS: { minimum: 50.00, maximum: 999999.99, currency: 'ARS', decimals: 2 },
    COP: { minimum: 1500.00, maximum: 999999999.99, currency: 'COP', decimals: 2 },
    PEN: { minimum: 1.50, maximum: 999999.99, currency: 'PEN', decimals: 2 },
    CLP: { minimum: 50, maximum: 9999999, currency: 'CLP', decimals: 0 }, // Zero decimal
    UYU: { minimum: 20.00, maximum: 999999.99, currency: 'UYU', decimals: 2 },
    PYG: { minimum: 3000.00, maximum: 999999999.99, currency: 'PYG', decimals: 2 },
    BOB: { minimum: 3.50, maximum: 999999.99, currency: 'BOB', decimals: 2 },
    VES: { minimum: 2.00, maximum: 999999.99, currency: 'VES', decimals: 2 },

    // ===== CENTRAL AMERICA & CARIBBEAN =====
    GTQ: { minimum: 4.00, maximum: 999999.99, currency: 'GTQ', decimals: 2 },
    HNL: { minimum: 12.00, maximum: 999999.99, currency: 'HNL', decimals: 2 },
    NIO: { minimum: 18.00, maximum: 999999.99, currency: 'NIO', decimals: 2 },
    CRC: { minimum: 300.00, maximum: 999999.99, currency: 'CRC', decimals: 2 },
    PAB: { minimum: 0.50, maximum: 999999.99, currency: 'PAB', decimals: 2 },
    DOP: { minimum: 28.00, maximum: 999999.99, currency: 'DOP', decimals: 2 },
    JMD: { minimum: 75.00, maximum: 999999.99, currency: 'JMD', decimals: 2 },
    TTD: { minimum: 3.50, maximum: 999999.99, currency: 'TTD', decimals: 2 },
    BBD: { minimum: 1.00, maximum: 999999.99, currency: 'BBD', decimals: 2 },
    BSD: { minimum: 0.50, maximum: 999999.99, currency: 'BSD', decimals: 2 },

    // ===== WESTERN EUROPE =====
    CHF: { minimum: 0.50, maximum: 999999.99, currency: 'CHF', decimals: 2 },

    // ===== NORTHERN EUROPE =====
    SEK: { minimum: 3.00, maximum: 999999.99, currency: 'SEK', decimals: 2 },
    NOK: { minimum: 3.00, maximum: 999999.99, currency: 'NOK', decimals: 2 },
    DKK: { minimum: 2.50, maximum: 999999.99, currency: 'DKK', decimals: 2 },
    ISK: { minimum: 50, maximum: 9999999, currency: 'ISK', decimals: 0 }, // Zero decimal

    // ===== EASTERN EUROPE =====
    PLN: { minimum: 2.00, maximum: 999999.99, currency: 'PLN', decimals: 2 },
    CZK: { minimum: 15.00, maximum: 999999.99, currency: 'CZK', decimals: 2 },
    HUF: { minimum: 175.00, maximum: 999999.99, currency: 'HUF', decimals: 2 },
    RON: { minimum: 2.00, maximum: 999999.99, currency: 'RON', decimals: 2 },
    BGN: { minimum: 1.00, maximum: 999999.99, currency: 'BGN', decimals: 2 },
    HRK: { minimum: 3.50, maximum: 999999.99, currency: 'HRK', decimals: 2 },
    RSD: { minimum: 50.00, maximum: 999999.99, currency: 'RSD', decimals: 2 },
    MKD: { minimum: 28.00, maximum: 999999.99, currency: 'MKD', decimals: 2 },
    ALL: { minimum: 50.00, maximum: 999999.99, currency: 'ALL', decimals: 2 },
    BAM: { minimum: 1.00, maximum: 999999.99, currency: 'BAM', decimals: 2 },
    UAH: { minimum: 15.00, maximum: 999999.99, currency: 'UAH', decimals: 2 },
    MDL: { minimum: 9.00, maximum: 999999.99, currency: 'MDL', decimals: 2 },

    // ===== EAST ASIA =====
    CNY: { minimum: 3.00, maximum: 999999.99, currency: 'CNY', decimals: 2 },
    JPY: { minimum: 50, maximum: 9999999, currency: 'JPY', decimals: 0 }, // Zero decimal
    KRW: { minimum: 50, maximum: 9999999, currency: 'KRW', decimals: 0 }, // Zero decimal
    HKD: { minimum: 4.00, maximum: 999999.99, currency: 'HKD', decimals: 2 },
    TWD: { minimum: 15.00, maximum: 999999.99, currency: 'TWD', decimals: 2 },
    MOP: { minimum: 4.00, maximum: 999999.99, currency: 'MOP', decimals: 2 },

    // ===== SOUTHEAST ASIA =====
    SGD: { minimum: 0.50, maximum: 999999.99, currency: 'SGD', decimals: 2 },
    MYR: { minimum: 2.00, maximum: 999999.99, currency: 'MYR', decimals: 2 },
    THB: { minimum: 10.00, maximum: 999999.99, currency: 'THB', decimals: 2 },
    PHP: { minimum: 20.00, maximum: 999999.99, currency: 'PHP', decimals: 2 },
    IDR: { minimum: 1000.00, maximum: 999999999.99, currency: 'IDR', decimals: 2 },
    VND: { minimum: 10000, maximum: 9999999, currency: 'VND', decimals: 0 }, // Zero decimal
    MMK: { minimum: 800.00, maximum: 999999.99, currency: 'MMK', decimals: 2 },
    KHR: { minimum: 2000.00, maximum: 999999.99, currency: 'KHR', decimals: 2 },
    LAK: { minimum: 4500.00, maximum: 999999999.99, currency: 'LAK', decimals: 2 },
    BND: { minimum: 0.50, maximum: 999999.99, currency: 'BND', decimals: 2 },

    // ===== SOUTH ASIA =====
    INR: { minimum: 0.50, maximum: 999999.99, currency: 'INR', decimals: 2 },
    PKR: { minimum: 85.00, maximum: 999999.99, currency: 'PKR', decimals: 2 },
    BDT: { minimum: 43.00, maximum: 999999.99, currency: 'BDT', decimals: 2 },
    LKR: { minimum: 90.00, maximum: 999999.99, currency: 'LKR', decimals: 2 },
    NPR: { minimum: 60.00, maximum: 999999.99, currency: 'NPR', decimals: 2 },
    BTN: { minimum: 35.00, maximum: 999999.99, currency: 'BTN', decimals: 2 },
    MVR: { minimum: 8.00, maximum: 999999.99, currency: 'MVR', decimals: 2 },
    AFN: { minimum: 40.00, maximum: 999999.99, currency: 'AFN', decimals: 2 },

    // ===== MIDDLE EAST =====
    AED: { minimum: 2.00, maximum: 999999.99, currency: 'AED', decimals: 2 },
    SAR: { minimum: 2.00, maximum: 999999.99, currency: 'SAR', decimals: 2 },
    QAR: { minimum: 2.00, maximum: 999999.99, currency: 'QAR', decimals: 2 },
    ILS: { minimum: 1.50, maximum: 999999.99, currency: 'ILS', decimals: 2 },
    KWD: { minimum: 0.15, maximum: 999999.99, currency: 'KWD', decimals: 3 }, // 3 decimals!
    BHD: { minimum: 0.20, maximum: 999999.99, currency: 'BHD', decimals: 3 }, // 3 decimals!
    OMR: { minimum: 0.20, maximum: 999999.99, currency: 'OMR', decimals: 3 }, // 3 decimals!
    JOD: { minimum: 0.35, maximum: 999999.99, currency: 'JOD', decimals: 3 }, // 3 decimals!
    TRY: { minimum: 5.00, maximum: 999999.99, currency: 'TRY', decimals: 2 },
    IQD: { minimum: 600.00, maximum: 999999.99, currency: 'IQD', decimals: 2 },
    LBP: { minimum: 750.00, maximum: 999999.99, currency: 'LBP', decimals: 2 },
    SYP: { minimum: 1250.00, maximum: 999999.99, currency: 'SYP', decimals: 2 },
    YER: { minimum: 125.00, maximum: 999999.99, currency: 'YER', decimals: 2 },

    // ===== NORTH AFRICA =====
    EGP: { minimum: 5.00, maximum: 999999.99, currency: 'EGP', decimals: 2 },
    MAD: { minimum: 5.00, maximum: 999999.99, currency: 'MAD', decimals: 2 },
    TND: { minimum: 1.50, maximum: 999999.99, currency: 'TND', decimals: 3 }, // 3 decimals!
    DZD: { minimum: 68.00, maximum: 999999.99, currency: 'DZD', decimals: 2 },
    LYD: { minimum: 2.30, maximum: 999999.99, currency: 'LYD', decimals: 3 }, // 3 decimals!

    // ===== WEST AFRICA =====
    NGN: { minimum: 100.00, maximum: 999999.99, currency: 'NGN', decimals: 2 },
    GHS: { minimum: 1.00, maximum: 999999.99, currency: 'GHS', decimals: 2 },
    XOF: { minimum: 300.00, maximum: 999999.99, currency: 'XOF', decimals: 0 }, // Zero decimal (West African CFA)
    XAF: { minimum: 300.00, maximum: 999999.99, currency: 'XAF', decimals: 0 }, // Zero decimal (Central African CFA)
    GMD: { minimum: 26.00, maximum: 999999.99, currency: 'GMD', decimals: 2 },
    SLL: { minimum: 5000.00, maximum: 999999999.99, currency: 'SLL', decimals: 2 },
    LRD: { minimum: 80.00, maximum: 999999.99, currency: 'LRD', decimals: 2 },

    // ===== EAST AFRICA =====
    KES: { minimum: 50.00, maximum: 999999.99, currency: 'KES', decimals: 2 },
    TZS: { minimum: 1150.00, maximum: 999999.99, currency: 'TZS', decimals: 2 },
    UGX: { minimum: 1000, maximum: 9999999, currency: 'UGX', decimals: 0 }, // Zero decimal
    RWF: { minimum: 500.00, maximum: 999999.99, currency: 'RWF', decimals: 2 },
    BIF: { minimum: 1000.00, maximum: 999999.99, currency: 'BIF', decimals: 0 }, // Zero decimal
    ETB: { minimum: 25.00, maximum: 999999.99, currency: 'ETB', decimals: 2 },
    SOS: { minimum: 290.00, maximum: 999999.99, currency: 'SOS', decimals: 2 },
    SDG: { minimum: 28.00, maximum: 999999.99, currency: 'SDG', decimals: 2 },

    // ===== SOUTHERN AFRICA =====
    ZAR: { minimum: 5.00, maximum: 999999.99, currency: 'ZAR', decimals: 2 },
    BWP: { minimum: 5.50, maximum: 999999.99, currency: 'BWP', decimals: 2 },
    NAD: { minimum: 7.50, maximum: 999999.99, currency: 'NAD', decimals: 2 },
    SZL: { minimum: 7.50, maximum: 999999.99, currency: 'SZL', decimals: 2 },
    LSL: { minimum: 7.50, maximum: 999999.99, currency: 'LSL', decimals: 2 },
    MWK: { minimum: 400.00, maximum: 999999.99, currency: 'MWK', decimals: 2 },
    ZMW: { minimum: 10.00, maximum: 999999.99, currency: 'ZMW', decimals: 2 },
    MZN: { minimum: 32.00, maximum: 999999.99, currency: 'MZN', decimals: 2 },
    AOA: { minimum: 250.00, maximum: 999999.99, currency: 'AOA', decimals: 2 },

    // ===== OCEANIA =====
    AUD: { minimum: 0.50, maximum: 999999.99, currency: 'AUD', decimals: 2 },
    NZD: { minimum: 0.50, maximum: 999999.99, currency: 'NZD', decimals: 2 },
    FJD: { minimum: 1.00, maximum: 999999.99, currency: 'FJD', decimals: 2 },
    PGK: { minimum: 1.80, maximum: 999999.99, currency: 'PGK', decimals: 2 },
    TOP: { minimum: 1.10, maximum: 999999.99, currency: 'TOP', decimals: 2 },
    WST: { minimum: 1.30, maximum: 999999.99, currency: 'WST', decimals: 2 },
    VUV: { minimum: 60, maximum: 9999999, currency: 'VUV', decimals: 0 }, // Zero decimal
    SBD: { minimum: 4.00, maximum: 999999.99, currency: 'SBD', decimals: 2 },

    // ===== CENTRAL ASIA =====
    KZT: { minimum: 215.00, maximum: 999999.99, currency: 'KZT', decimals: 2 },
    UZS: { minimum: 5300.00, maximum: 999999999.99, currency: 'UZS', decimals: 2 },
    TJS: { minimum: 5.50, maximum: 999999.99, currency: 'TJS', decimals: 2 },
    KGS: { minimum: 43.00, maximum: 999999.99, currency: 'KGS', decimals: 2 },
    TMT: { minimum: 1.80, maximum: 999999.99, currency: 'TMT', decimals: 2 },
    AZN: { minimum: 0.85, maximum: 999999.99, currency: 'AZN', decimals: 2 },
    GEL: { minimum: 1.30, maximum: 999999.99, currency: 'GEL', decimals: 2 },
    AMD: { minimum: 200.00, maximum: 999999.99, currency: 'AMD', decimals: 2 },

    // ===== OTHER TERRITORIES =====
    MUR: { minimum: 20.00, maximum: 999999.99, currency: 'MUR', decimals: 2 }, // Mauritius
    SCR: { minimum: 7.00, maximum: 999999.99, currency: 'SCR', decimals: 2 }, // Seychelles
    MGA: { minimum: 1900.00, maximum: 999999.99, currency: 'MGA', decimals: 2 }, // Madagascar
    XPF: { minimum: 60, maximum: 9999999, currency: 'XPF', decimals: 0 }, // French Pacific territories
  }

  if (specificLimits[curr]) {
    return specificLimits[curr]
  }

  // Fail if currency not supported by Stripe
  throw new Error(`Stripe limits not found for currency: ${curr}. This currency may not be supported by Stripe.`)
}

/**
 * Validate if an amount meets Stripe's requirements for a currency
 */
export function validateStripeAmount(amount: number, currency: string): {
  valid: boolean
  error?: string
  minimum: number
  maximum: number
} {
  const limits = getStripeLimits(currency)

  if (amount < limits.minimum) {
    return {
      valid: false,
      error: `Amount must be at least ${formatStripeCurrency(limits.minimum, currency)}`,
      minimum: limits.minimum,
      maximum: limits.maximum,
    }
  }

  if (amount > limits.maximum) {
    return {
      valid: false,
      error: `Amount must not exceed ${formatStripeCurrency(limits.maximum, currency)}`,
      minimum: limits.minimum,
      maximum: limits.maximum,
    }
  }

  return {
    valid: true,
    minimum: limits.minimum,
    maximum: limits.maximum,
  }
}

/**
 * Format currency for display with proper symbol
 */
function formatStripeCurrency(amount: number, currency: string): string {
  const symbols: { [key: string]: string } = {
    // Major
    USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥',
    // Americas
    CAD: 'C$', AUD: 'A$', BRL: 'R$', MXN: '$', ARS: '$', COP: '$',
    PEN: 'S/', CLP: '$', UYU: '$', PYG: '₲', BOB: 'Bs',
    // Asia
    INR: '₹', SGD: 'S$', MYR: 'RM', THB: '฿', PHP: '₱', IDR: 'Rp',
    VND: '₫', KRW: '₩', HKD: 'HK$', TWD: 'NT$', PKR: '₨',
    BDT: '৳', LKR: 'Rs', NPR: 'Rs', MMK: 'K', KHR: '៛',
    // Africa
    NGN: '₦', ZAR: 'R', KES: 'KSh', GHS: '₵', EGP: 'E£',
    MAD: 'د.م.', TZS: 'TSh', UGX: 'USh', RWF: 'Fr', ETB: 'Br',
    // Middle East
    AED: 'د.إ', SAR: '﷼', QAR: 'ر.ق', ILS: '₪', KWD: 'د.ك',
    BHD: 'د.ب', OMR: 'ر.ع.', JOD: 'د.ا', TRY: '₺',
    // Europe
    CHF: 'Fr', SEK: 'kr', NOK: 'kr', DKK: 'kr', PLN: 'zł',
    CZK: 'Kč', HUF: 'Ft', RON: 'lei', BGN: 'лв', HRK: 'kn',
    RSD: 'дин', UAH: '₴', ISK: 'kr',
    // Oceania
    NZD: 'NZ$', FJD: 'FJ$', PGK: 'K', TOP: 'T$', WST: 'WS$',
    // CFA Franc
    XOF: 'Fr', XAF: 'Fr',
  }

  const symbol = symbols[currency.toUpperCase()] || currency.toUpperCase() + ' '
  const limits = getStripeLimits(currency)

  const formatted = amount.toLocaleString('en-US', {
    minimumFractionDigits: limits.decimals,
    maximumFractionDigits: limits.decimals,
  })

  return `${symbol}${formatted}`
}

/**
 * Convert amount to Stripe's smallest unit (e.g., cents)
 */
export function toStripeAmount(amount: number, currency: string): number {
  const limits = getStripeLimits(currency)

  if (limits.decimals === 0) {
    return Math.round(amount)
  }

  return Math.round(amount * Math.pow(10, limits.decimals))
}

/**
 * Convert from Stripe's smallest unit back to major units
 */
export function fromStripeAmount(amount: number, currency: string): number {
  const limits = getStripeLimits(currency)

  if (limits.decimals === 0) {
    return amount
  }

  return amount / Math.pow(10, limits.decimals)
}
