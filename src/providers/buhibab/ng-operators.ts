// Ported verbatim from TopupApp src/lib/ng-operators.ts — static Nigerian
// operator metadata (buhibab's API returns no logos) + prefix-based operator
// detection (buhibab has no server-side auto-detect endpoint).

export interface NgOperatorMeta {
  logo: string
  displayName: string
  brandColor: string
}

const NG_OPERATORS: Record<string, NgOperatorMeta> = {
  mtn: { logo: '/images/operators/ng/mtn.svg', displayName: 'MTN', brandColor: '#FFCB05' },
  airtel: { logo: '/images/operators/ng/airtel.svg', displayName: 'Airtel', brandColor: '#ED1C24' },
  glo: { logo: '/images/operators/ng/glo.svg', displayName: 'Glo', brandColor: '#006B3F' },
  '9mobile': { logo: '/images/operators/ng/9mobile.svg', displayName: '9mobile', brandColor: '#006B45' },
  etisalat: { logo: '/images/operators/ng/9mobile.svg', displayName: '9mobile', brandColor: '#006B45' },
  ikedc: { logo: '/images/operators/ng/ikedc.svg', displayName: 'IKEDC', brandColor: '#1A3C6E' },
  spectranet: { logo: '/images/operators/ng/spectranet.svg', displayName: 'Spectranet', brandColor: '#5C2D91' },
  smile: { logo: '/images/operators/ng/smile.svg', displayName: 'Smile', brandColor: '#F37021' },
}

export function subServiceToBillerType(subServiceName: string): string {
  const map: Record<string, string> = {
    electricity: 'ELECTRICITY',
    internet: 'INTERNET',
    'cable tv': 'TV',
    water: 'WATER',
    gas: 'GAS',
  }
  return map[subServiceName.toLowerCase()] ?? subServiceName.toUpperCase()
}

export function getNgOperatorMeta(operatorName: string): NgOperatorMeta {
  const key = operatorName.toLowerCase().trim()
  return (
    NG_OPERATORS[key] ?? { logo: '', displayName: operatorName, brandColor: '#6B7280' }
  )
}

const NG_PREFIX_MAP: Record<string, string> = {
  '0803': 'MTN', '0806': 'MTN', '0810': 'MTN', '0813': 'MTN',
  '0814': 'MTN', '0816': 'MTN', '0903': 'MTN', '0906': 'MTN',
  '0913': 'MTN', '0916': 'MTN', '0703': 'MTN', '0706': 'MTN',

  '0802': 'Airtel', '0808': 'Airtel', '0812': 'Airtel',
  '0701': 'Airtel', '0708': 'Airtel', '0902': 'Airtel',
  '0901': 'Airtel', '0907': 'Airtel', '0912': 'Airtel',

  '0805': 'Glo', '0807': 'Glo', '0811': 'Glo',
  '0815': 'Glo', '0905': 'Glo', '0915': 'Glo', '0705': 'Glo',

  '0809': '9mobile', '0817': '9mobile', '0818': '9mobile',
  '0908': '9mobile', '0909': '9mobile',
}

export function detectNgOperator(phone: string): string | null {
  let local = phone.replace(/[\s\-()]/g, '')

  if (local.startsWith('+234')) local = '0' + local.slice(4)
  else if (local.startsWith('234') && local.length > 10) local = '0' + local.slice(3)

  if (!local.startsWith('0') && /^[789]/.test(local)) local = '0' + local

  const prefix = local.slice(0, 4)
  return NG_PREFIX_MAP[prefix] ?? null
}
