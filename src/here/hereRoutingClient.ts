/**
 * HERE Routing API v8 client — SERVER-SIDE ONLY. The API key comes from the
 * environment and must never reach the client bundle (PRD §4.1).
 *
 * Parameter names verified against the current HERE Routing v8 API reference
 * (2026-07): the PRD's indicative `truck[axleCount]`/`truck[grossWeight]`
 * spellings are outdated — the current parameter family is `vehicle[...]`.
 * `tolls[emissionType]` accepts euro1..euro6/euroEev; `currency` is ISO 4217.
 */

export interface TollVehicleProfile {
  axleCount: number
  /** Gross vehicle weight in kg (HERE expects kilograms). */
  grossWeightKg: number
  /** euro1..euro6 or euroEev. Fleet is uniform Euro 6. */
  emissionType: string
}

export interface HerePlace {
  lat: number
  lon: number
}

export interface HereRouteRequest {
  origin: HerePlace
  destination: HerePlace
  /** Intermediate stops, in order. One `via` query parameter each. */
  via: HerePlace[]
  profile: TollVehicleProfile
}

/** Subset of the HERE v8 response the app consumes. */
export interface HereRouteResponse {
  routes: Array<{
    sections: Array<HereSection>
  }>
  notices?: Array<{ title?: string; code?: string }>
}

export interface HereSection {
  summary: { length: number; duration?: number } // length in METRES (PRD §4.2)
  polyline: string
  spans?: Array<{ offset: number; countryCode: string }>
  tolls?: Array<HereTollCost>
  notices?: Array<{ title?: string; code?: string }>
}

export interface HereTollCost {
  countryCode?: string // ISO alpha-3
  tollSystem?: string
  fares: Array<{
    id: string
    price?: { value?: number; currency?: string }
    convertedPrice?: { value?: number; currency?: string }
  }>
}

export class HereApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'HereApiError'
  }
}

export const HERE_ROUTER_BASE_URL = 'https://router.hereapi.com/v8/routes'

export function buildRouteRequestUrl(baseUrl: string, apiKey: string, request: HereRouteRequest): URL {
  const url = new URL(baseUrl)
  const p = url.searchParams
  p.set('apikey', apiKey)
  p.set('transportMode', 'truck')
  p.set('origin', `${request.origin.lat},${request.origin.lon}`)
  p.set('destination', `${request.destination.lat},${request.destination.lon}`)
  for (const stop of request.via) p.append('via', `${stop.lat},${stop.lon}`)
  // tolls in the SAME call as summary+polyline — zero extra quota (PRD §4.3)
  p.set('return', 'summary,polyline,tolls')
  p.set('spans', 'countryCode')
  p.set('vehicle[axleCount]', String(request.profile.axleCount))
  p.set('vehicle[grossWeight]', String(request.profile.grossWeightKg))
  p.set('tolls[emissionType]', request.profile.emissionType)
  p.set('currency', 'EUR')
  return url
}

export interface HereRoutingClientOptions {
  apiKey: string
  baseUrl?: string
  fetchFn?: typeof fetch
  timeoutMs?: number
}

export class HereRoutingClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch
  private readonly timeoutMs: number

  constructor(options: HereRoutingClientOptions) {
    if (!options.apiKey) throw new Error('HereRoutingClient requires a non-empty API key.')
    this.apiKey = options.apiKey
    this.baseUrl = options.baseUrl ?? HERE_ROUTER_BASE_URL
    this.fetchFn = options.fetchFn ?? fetch
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  async fetchRoute(request: HereRouteRequest): Promise<HereRouteResponse> {
    const url = buildRouteRequestUrl(this.baseUrl, this.apiKey, request)
    let response: Response
    try {
      response = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) })
    } catch (error) {
      // Never leak the URL (it contains the API key) into error messages.
      const kind = error instanceof Error ? error.name : 'unknown'
      throw new HereApiError(`HERE routing request failed before a response was received (${kind}).`)
    }
    if (!response.ok) {
      throw new HereApiError(`HERE routing request failed with HTTP ${response.status}.`, response.status)
    }
    return (await response.json()) as HereRouteResponse
  }
}
