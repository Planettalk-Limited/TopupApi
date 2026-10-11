// buhibab Healthcare (WellaHealth) API shapes — undocumented upstream; captured from
// the live API on 2026-10-03.

export interface HealthcarePharmacy {
  pharmacyCode: string
  pharmacyName: string
  state: string
  lga: string
  area: string
  address: string
}

export interface HealthcarePharmaciesResponse {
  data: HealthcarePharmacy[]
  pageCount: number
  pageIndex: number
  pageSize: number
}

export interface RawHealthcareDrug {
  genericName?: string
  brandName?: string
  drugClass?: string
  dosageForm?: string
  strength?: string
  packSize?: number
  drugName: string
  /** NGN per pack. */
  drugPrice: number
  /** NGN per single unit (tablet etc.). */
  unitPrice: number
  notes?: string
  dateUpdated?: string
}

/** What our catalog endpoint returns to the frontend. */
export interface HealthcareDrug {
  drugName: string
  genericName: string | null
  brandName: string | null
  drugClass: string | null
  dosageForm: string | null
  strength: string | null
  packSize: number | null
  /** NGN per pack. */
  price: number
  currency: 'NGN'
}
