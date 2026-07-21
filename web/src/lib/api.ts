import type {
  AirportDto,
  CalculationDto,
  CalculatorConfig,
  FetchedRouteDto,
  FleetVariantDto,
  RouteDetailsDto,
  RouteSummaryDto,
  SaveCalculationInput,
  TollRuleType,
  TollSystemRuleDto,
  UserDto,
  UserRole,
} from './types.js'

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

/**
 * Called when any request (except login) comes back 401 — the session
 * expired or was revoked. The auth provider registers a handler that
 * returns the app to the login screen.
 */
let onUnauthenticated: (() => void) | null = null
export function setUnauthenticatedHandler(handler: (() => void) | null): void {
  onUnauthenticated = handler
}

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
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
    if (response.status === 401 && code === 'UNAUTHENTICATED' && onUnauthenticated !== null) {
      onUnauthenticated()
    }
    throw new ApiError(code, message, response.status)
  }
  return (await response.json()) as T
}

export const api = {
  // --- Auth ---

  async login(email: string, password: string): Promise<UserDto> {
    return (await request<{ user: UserDto }>('POST', '/api/auth/login', { email, password })).user
  },

  async logout(): Promise<void> {
    await request<{ ok: boolean }>('POST', '/api/auth/logout')
  },

  /** Returns null when there is no valid session. */
  async me(): Promise<UserDto | null> {
    try {
      return (await request<{ user: UserDto }>('GET', '/api/auth/me')).user
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null
      throw error
    }
  },

  // --- Admin user management ---

  async listUsers(): Promise<UserDto[]> {
    return (await request<{ users: UserDto[] }>('GET', '/api/users')).users
  },

  async createUser(input: { email: string; displayName: string; role: UserRole; password: string }): Promise<UserDto> {
    return (await request<{ user: UserDto }>('POST', '/api/users', input)).user
  },

  async patchUser(
    id: number,
    patch: { role?: UserRole; active?: boolean; password?: string; displayName?: string },
  ): Promise<UserDto> {
    return (await request<{ user: UserDto }>('PATCH', `/api/users/${id}`, patch)).user
  },

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

  /** Backfill the map shape for a stored route (1 HERE request; shape only). */
  async refreshRouteShape(routeCode: string): Promise<RouteDetailsDto> {
    return (await request<{ route: RouteDetailsDto }>('POST', `/api/routes/${encodeURIComponent(routeCode)}/shape`))
      .route
  },

  // --- Route DB screen (PRD §5.3) ---

  async listRoutes(): Promise<RouteSummaryDto[]> {
    return (await request<{ routes: RouteSummaryDto[] }>('GET', '/api/routes')).routes
  },

  async overrideKm(
    routeCode: string,
    body: { totalKm: number; countryKm: Record<string, number>; note?: string },
  ): Promise<RouteDetailsDto> {
    return (await request<{ route: RouteDetailsDto }>('PUT', `/api/routes/${encodeURIComponent(routeCode)}/km`, body))
      .route
  },

  /** Fill in a pending toll — stored as verified (manual entry). */
  async setToll(routeCode: string, country: string, tollEur: number): Promise<RouteDetailsDto> {
    return (
      await request<{ route: RouteDetailsDto }>(
        'PUT',
        `/api/routes/${encodeURIComponent(routeCode)}/tolls/${encodeURIComponent(country)}`,
        { tollEur },
      )
    ).route
  },

  /** Promote an estimate to verified, optionally correcting the value. */
  async verifyToll(routeCode: string, country: string, correctedTollEur?: number): Promise<RouteDetailsDto> {
    return (
      await request<{ route: RouteDetailsDto }>(
        'POST',
        `/api/routes/${encodeURIComponent(routeCode)}/tolls/${encodeURIComponent(country)}/verify`,
        correctedTollEur === undefined ? {} : { correctedTollEur },
      )
    ).route
  },

  // --- Config screen (PRD §5.3) ---

  async updateConfig(config: {
    fuelPriceEurPerLitre: number
    fuelConsumptionLPer100Km: number
    driverDayRateEur: number
    monthlyOverheadEur: number
    monthDays: number
  }): Promise<CalculatorConfig> {
    return (await request<{ config: CalculatorConfig }>('PUT', '/api/config', config)).config
  },

  async createVariant(name: string, monthlyCostEur: number): Promise<FleetVariantDto[]> {
    return (await request<{ variants: FleetVariantDto[] }>('POST', '/api/fleet-variants', { name, monthlyCostEur }))
      .variants
  },

  async patchVariant(id: number, patch: { monthlyCostEur?: number; active?: boolean }): Promise<FleetVariantDto[]> {
    return (await request<{ variants: FleetVariantDto[] }>('PATCH', `/api/fleet-variants/${id}`, patch)).variants
  },

  // --- Toll-system correction rules (config screen) ---

  async listTollRules(): Promise<TollSystemRuleDto[]> {
    return (await request<{ rules: TollSystemRuleDto[] }>('GET', '/api/toll-rules')).rules
  },

  async upsertTollRule(input: {
    tollSystem: string
    ruleType: TollRuleType
    value: number
    note?: string
  }): Promise<TollSystemRuleDto[]> {
    return (await request<{ rules: TollSystemRuleDto[] }>('PUT', '/api/toll-rules', input)).rules
  },

  async deleteTollRule(id: number): Promise<TollSystemRuleDto[]> {
    return (await request<{ rules: TollSystemRuleDto[] }>('DELETE', `/api/toll-rules/${id}`)).rules
  },

  // --- History screen (PRD §5.3) ---

  async saveCalculation(input: SaveCalculationInput): Promise<CalculationDto> {
    return (await request<{ calculation: CalculationDto }>('POST', '/api/calculations', input)).calculation
  },

  async listCalculations(routeCode?: string): Promise<CalculationDto[]> {
    const query = routeCode === undefined || routeCode === '' ? '' : `?route=${encodeURIComponent(routeCode)}`
    return (await request<{ calculations: CalculationDto[] }>('GET', `/api/calculations${query}`)).calculations
  },
}

export type Api = typeof api
