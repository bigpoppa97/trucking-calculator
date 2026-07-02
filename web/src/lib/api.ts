import type { AirportDto, CalculatorConfig, FetchedRouteDto, FleetVariantDto, RouteDetailsDto } from './types.js'

/**
 * All backend calls go through this module. Every failure becomes an
 * ApiError with a stable code — components never see raw fetch errors.
 */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const init: RequestInit =
    body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    throw new ApiError('NETWORK', 'Brak połączenia z serwerem. Sprawdź, czy backend działa.')
  }

  if (!response.ok) {
    let code = 'HTTP_ERROR'
    let message = 'Serwer zwrócił błąd. Spróbuj ponownie.'
    try {
      const payload = (await response.json()) as { error?: { code?: string; message?: string } }
      if (payload.error?.code) code = payload.error.code
      if (payload.error?.message) message = payload.error.message
    } catch {
      // keep generic message
    }
    throw new ApiError(code, message, response.status)
  }
  return (await response.json()) as T
}

export const api = {
  async getConfig(): Promise<CalculatorConfig> {
    return (await request<{ config: CalculatorConfig }>('GET', '/api/config')).config
  },

  async getFleetVariants(): Promise<FleetVariantDto[]> {
    return (await request<{ variants: FleetVariantDto[] }>('GET', '/api/fleet-variants')).variants
  },

  async getAirports(): Promise<AirportDto[]> {
    return (await request<{ airports: AirportDto[] }>('GET', '/api/airports')).airports
  },

  /** Table-first lookup (PRD §3.2 step 1). Returns null on the explicit not-found state. */
  async getRoute(routeCode: string): Promise<RouteDetailsDto | null> {
    try {
      const body = await request<{ route: RouteDetailsDto }>('GET', `/api/routes/${encodeURIComponent(routeCode)}`)
      return body.route
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ROUTE_NOT_FOUND') return null
      throw error
    }
  },

  /** The user-confirmed HERE call (PRD §3.2 step 2). */
  async fetchRouteFromHere(routeCode: string): Promise<FetchedRouteDto> {
    return (await request<{ fetched: FetchedRouteDto }>('POST', '/api/here/route-fetch', { routeCode })).fetched
  },

  /** "Save to route database" (PRD §3.2 step 3). */
  async saveFetchedRoute(fetched: FetchedRouteDto): Promise<RouteDetailsDto> {
    return (await request<{ route: RouteDetailsDto }>('POST', '/api/routes', fetched)).route
  },
}

export type Api = typeof api
