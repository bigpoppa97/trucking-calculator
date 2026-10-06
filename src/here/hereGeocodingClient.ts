import { alpha3ToAlpha2 } from './countryCodes.js'

/**
 * HERE Geocoding & Search v7 — SERVER-SIDE ONLY (same key as routing).
 * Used by the board to propose coordinates for a place it does not know yet
 * (a trailer-swap point like "Gorzyczki" or a car park on the motorway).
 */

export interface GeocodeCandidate {
  title: string
  lat: number
  lon: number
  country: string
}

export const HERE_GEOCODE_URL = 'https://geocode.search.hereapi.com/v1/geocode'

export class HereGeocodingClient {
  constructor(
    private readonly options: { apiKey: string; baseUrl?: string; fetchFn?: typeof fetch; timeoutMs?: number },
  ) {
    if (!options.apiKey) throw new Error('HereGeocodingClient requires a non-empty API key.')
  }

  async geocode(query: string, limit = 5): Promise<GeocodeCandidate[]> {
    const url = new URL(this.options.baseUrl ?? HERE_GEOCODE_URL)
    url.searchParams.set('q', query)
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('lang', 'pl-PL')
    url.searchParams.set('in', 'countryCode:POL,DEU,CZE,SVK,AUT,HUN,LTU,LVA,EST,ROU,BGR,NLD,BEL,LUX,FRA,ITA,DNK,SWE,FIN,SVN,HRV,CHE,ESP')
    url.searchParams.set('apiKey', this.options.apiKey)
    let response: Response
    try {
      response = await (this.options.fetchFn ?? fetch)(url, { signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000) })
    } catch {
      return []
    }
    if (!response.ok) return []
    const body = (await response.json()) as {
      items?: Array<{ title?: string; position?: { lat: number; lng: number }; address?: { countryCode?: string } }>
    }
    return (body.items ?? [])
      .filter(i => i.position)
      .map(i => ({
        title: i.title ?? query,
        lat: i.position!.lat,
        lon: i.position!.lng,
        country: alpha3ToAlpha2(i.address?.countryCode ?? '') ?? '',
      }))
  }
}
