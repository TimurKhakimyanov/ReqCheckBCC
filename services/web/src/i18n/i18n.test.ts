import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PIPELINE_STAGES, PROVIDERS, REVIEW_STATUSES } from '@/api/types'
import { ALL_CRITERIA, SEVERITIES } from '@/shared/criteria'
import i18n, { languages, resources } from './index'

type Tree = { [k: string]: string | Tree }

function flatten(obj: Tree, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => (typeof v === 'string' ? [prefix + k] : flatten(v, `${prefix}${k}.`)))
}
const PLURAL = /_(zero|one|two|few|many|other)$/
const keysOf = (lng: string) => new Set(flatten(resources[lng].translation as Tree).map((k) => k.replace(PLURAL, '')))

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return sourceFiles(p)
    return /\.(tsx?)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : []
  })
}

describe('i18n', () => {
  it('discovers every locale file automatically', () => {
    expect(languages.map((l) => l.code)).toEqual(['ru', 'en', 'kk'])
    expect(languages.find((l) => l.code === 'kk')?.ready).toBe(false)
  })

  it('ru and en have the same keys', () => {
    const ru = keysOf('ru')
    const en = keysOf('en')
    expect([...ru].filter((k) => !en.has(k))).toEqual([])
    expect([...en].filter((k) => !ru.has(k))).toEqual([])
  })

  it('every static t() key used in the code exists in ru and en', () => {
    const src = path.resolve(__dirname, '..')
    const used = new Set<string>()
    for (const file of sourceFiles(src)) {
      const code = fs.readFileSync(file, 'utf8')
      for (const m of code.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) used.add(m[1])
      for (const m of code.matchAll(/key: '([a-z]+\.[a-zA-Z.]+)'/g)) used.add(m[1])
    }
    expect(used.size).toBeGreaterThan(100)
    for (const lng of ['ru', 'en']) {
      const keys = keysOf(lng)
      expect([...used].filter((k) => !keys.has(k)), lng).toEqual([])
    }
  })

  it('dynamic key families are complete', () => {
    const dynamic = [
      ...PIPELINE_STAGES.map((s) => `stage.${s}`),
      'stage.failed',
      'stage.cancelled',
      ...PIPELINE_STAGES.filter((s) => s !== 'done').map((s) => `stageHint.${s}`),
      ...SEVERITIES.map((s) => `severity.${s}`),
      ...REVIEW_STATUSES.map((s) => `review.${s}`),
      ...PROVIDERS.map((p) => `provider.${p}`),
      ...PROVIDERS.map((p) => `settings.providerHint.${p}`),
      ...ALL_CRITERIA.flatMap((c) => [`criteria.${c}.title`, `criteria.${c}.short`, `criteria.${c}.description`]),
      ...['verify_pass', 'split_compound', 'fill_checklist'].flatMap((o) => [`launch.opt.${o}`, `launch.opt.${o}Hint`]),
      ...['upload.badFormat', 'upload.tooLarge'],
    ]
    for (const lng of ['ru', 'en']) {
      const keys = keysOf(lng)
      expect(dynamic.filter((k) => !keys.has(k)), lng).toEqual([])
    }
  })

  it('uses Russian plural forms and falls back from kk to ru', async () => {
    await i18n.changeLanguage('ru')
    expect(i18n.t('report.findingCount', { count: 1 })).toBe('1 дефект')
    expect(i18n.t('report.findingCount', { count: 3 })).toBe('3 дефекта')
    expect(i18n.t('report.findingCount', { count: 7 })).toBe('7 дефектов')
    await i18n.changeLanguage('en')
    expect(i18n.t('report.findingCount', { count: 7 })).toBe('7 findings')
    await i18n.changeLanguage('kk')
    expect(i18n.t('nav.documents')).toBe('Құжаттар')
    expect(i18n.t('report.tabs.matrix')).toBe('Матрица')
    await i18n.changeLanguage('ru')
  })
})
