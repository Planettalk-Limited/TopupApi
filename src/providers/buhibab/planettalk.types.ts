// Ported from TopupApp src/types/planettalk.ts — buhibab.com ("PlanetTalk"
// provider) API shapes. Nigeria-only utility & telecom bill payment.

export interface PlanetTalkAuthResponse {
  token: string
  expires_at: string
}

export interface PlanetTalkCountry {
  id: number
  sortname: string
  name: string
  currency_code: string
  currency_symbol: string
}

export interface PlanetTalkAdditionalField {
  name: string
  label: string
  required: boolean
  description: string
}

export interface PlanetTalkProduct {
  id: number
  name: string
  operator_name: string
  value_amount: number
  price: number
  value_amount_max: number | null
  price_max: number | null
  fixed_price: boolean
  destination_country: PlanetTalkCountry
  additional_fields: PlanetTalkAdditionalField[]
}

export interface PlanetTalkSubService {
  id: number
  app_service_id: number
  name: string
  created_at: string | null
  updated_at: string | null
}

export interface PlanetTalkProductGroup {
  sub_service: PlanetTalkSubService
  products: PlanetTalkProduct[]
}

export interface PlanetTalkProductsResponse {
  message: string
  data: PlanetTalkProductGroup[]
}
