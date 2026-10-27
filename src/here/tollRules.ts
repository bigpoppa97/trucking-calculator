import type { TollRuleType } from '../db/schema.js'

/**
 * Matching HERE tolls to correction rules (config screen "Korekty systemów
 * poboru opłat").
 *
 * - The SYSTEM name must match exactly after normalisation (case, diacritics,
 *   whitespace). No fuzzy matching on purpose: "A2 AUTOSTRADA WIELKOPOLSKA"
 *   must not silently cover a different concessionaire such as a future
 *   "A2 AUTOSTRADA WIELKOPOLSKA II" with another tariff — an unmatched system
 *   is reported instead (tollChecks.ts), and the config screen suggests the
 *   names HERE actually returned.
 * - A rule with a gate filter applies only to tolls whose gate / fare name
 *   contains the filter, and wins over the system-wide rule (longest filter
 *   first). Used for A2 Świecko–Nowy Tomyśl, priced differently from
 *   Nowy Tomyśl–Konin although HERE may report both under one system.
 */

export interface TollRuleLike {
  id: number
  tollSystem: string
  /** '' / undefined = the whole system. */
  gateFilter?: string
  ruleType: TollRuleType
  value: number
}

/** Upper-case, no diacritics (incl. Ł), single spaces. */
export function normalizeTollName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export function findTollRule<R extends TollRuleLike>(
  rules: readonly R[],
  tollSystem: string | undefined,
  gateLabels: readonly string[],
): R | undefined {
  if (tollSystem === undefined || tollSystem.trim() === '') return undefined
  const system = normalizeTollName(tollSystem)
  const forSystem = rules.filter(rule => normalizeTollName(rule.tollSystem) === system)
  if (forSystem.length === 0) return undefined

  const labels = gateLabels.map(normalizeTollName).filter(label => label !== '')
  const gateSpecific = forSystem
    .filter(rule => (rule.gateFilter ?? '').trim() !== '')
    .sort((a, b) => (b.gateFilter ?? '').length - (a.gateFilter ?? '').length)
  for (const rule of gateSpecific) {
    const filter = normalizeTollName(rule.gateFilter ?? '')
    if (labels.some(label => label.includes(filter))) return rule
  }
  return forSystem.find(rule => (rule.gateFilter ?? '').trim() === '')
}

/** Identity of a rule's effect — changes when the rule is edited, replaced or deleted. */
export function tollRuleSignature(rule: TollRuleLike | undefined): string | null {
  if (rule === undefined) return null
  return `${rule.id}|${rule.ruleType}|${rule.value}|${normalizeTollName(rule.gateFilter ?? '')}`
}

/** Human label of a rule, e.g. "A2 AUTOSTRADA WIELKOPOLSKA · bramka „Świecko”". */
export function tollRuleLabel(rule: Pick<TollRuleLike, 'tollSystem' | 'gateFilter'>): string {
  const gate = (rule.gateFilter ?? '').trim()
  return gate === '' ? rule.tollSystem : `${rule.tollSystem} · bramka „${gate}”`
}
