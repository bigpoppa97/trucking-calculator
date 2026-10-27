import { afterEach, describe, expect, it } from 'vitest'
import { clearCalcSession, loadCalcSession, loadScreen, saveCalcForm, saveCalcRoute, saveScreen } from './calcSession.js'

afterEach(() => sessionStorage.clear())

describe('calcSession', () => {
  it('starts empty and survives garbage in storage', () => {
    expect(loadCalcSession()).toEqual({ route: null, form: null })
    sessionStorage.setItem('kalkulator.sesja.v1', '{not json')
    expect(loadCalcSession()).toEqual({ route: null, form: null })
    sessionStorage.setItem('kalkulator.sesja.v1', JSON.stringify({ route: { kind: 'db', routeCode: '' }, form: { days: 1 } }))
    expect(loadCalcSession()).toEqual({ route: null, form: null })
  })

  it('keeps route and form independently', () => {
    saveCalcRoute({ kind: 'db', routeCode: 'WAW-PRG' })
    saveCalcForm({ days: '1,5', drivers: 2, fleetVariantId: 3, ferries: '0', tunnels: '0', revenue: '900' })
    saveCalcRoute({ kind: 'notFound', routeCode: 'WAW-XYZ' })
    expect(loadCalcSession()).toEqual({
      route: { kind: 'notFound', routeCode: 'WAW-XYZ' },
      form: { days: '1,5', drivers: 2, fleetVariantId: 3, ferries: '0', tunnels: '0', revenue: '900' },
    })
  })

  it('sign-out clears the calculator and the remembered screen', () => {
    saveCalcRoute({ kind: 'db', routeCode: 'WAW-PRG' })
    saveScreen('calculator', 'routes')
    expect(loadScreen()).toEqual({ screen: 'calculator', calc: 'routes' })
    clearCalcSession()
    expect(loadCalcSession().route).toBeNull()
    expect(loadScreen()).toBeNull()
  })
})
