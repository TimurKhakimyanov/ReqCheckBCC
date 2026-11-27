// Критерии из packages/contracts/req_contracts/criteria.py. Названия и описания — в локалях (criteria.<code>.*).
import type { Criterion, Severity } from '@/api/types'

export const REQUIREMENT_CRITERIA: Criterion[] = [
  'necessary',
  'implementation_free',
  'unambiguous',
  'complete',
  'singular',
  'feasible',
  'verifiable',
  'correct',
  'conforming',
  'traceable',
]

export const SET_CRITERIA: Criterion[] = [
  'set_complete',
  'set_consistent',
  'set_feasible',
  'set_comprehensible',
  'set_validatable',
  'set_ranked',
  'set_modifiable',
  'set_traceable',
]

export const ALL_CRITERIA: Criterion[] = [...REQUIREMENT_CRITERIA, ...SET_CRITERIA]

export const CRITERION_REFS: Record<Criterion, string[]> = {
  necessary: ['29148 5.2.5 a'],
  implementation_free: ['29148 5.2.5 b'],
  unambiguous: ['29148 5.2.5 c', 'IEEE 830 4.3.2'],
  complete: ['29148 5.2.5 d', 'IEEE 830 4.3.3'],
  singular: ['29148 5.2.5 e'],
  feasible: ['29148 5.2.5 f'],
  verifiable: ['29148 5.2.5 g', 'IEEE 830 4.3.6'],
  correct: ['29148 5.2.5 h', 'IEEE 830 4.3.1'],
  conforming: ['29148 5.2.5 i'],
  traceable: ['IEEE 830 4.3.8'],
  set_complete: ['29148 5.2.6 a', 'IEEE 830 4.3.3'],
  set_consistent: ['29148 5.2.6 b', 'IEEE 830 4.3.4'],
  set_feasible: ['29148 5.2.6 c'],
  set_comprehensible: ['29148 5.2.6 d'],
  set_validatable: ['29148 5.2.6 e'],
  set_ranked: ['IEEE 830 4.3.5'],
  set_modifiable: ['IEEE 830 4.3.7'],
  set_traceable: ['IEEE 830 4.3.8'],
}

export const SEVERITIES: Severity[] = ['critical', 'major', 'minor']
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, major: 1, minor: 2 }
