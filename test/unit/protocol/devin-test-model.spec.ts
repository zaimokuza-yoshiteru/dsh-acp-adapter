import { expect, it } from 'vitest'
import {
  assertDevinTeamModelRoutes,
  DEFAULT_DEVIN_TEST_MODEL,
  selectDevinTestModel,
} from '../../../scripts/devin-test-model.ts'

const catalog = [{ id: DEFAULT_DEVIN_TEST_MODEL }, { id: 'swe-1-7-medium' }] as const

it('defaults to the fixed Devin test model and supports an exact override', () => {
  expect(DEFAULT_DEVIN_TEST_MODEL).toBe('swe-2-high')
  expect(selectDevinTestModel(catalog, undefined)).toBe(catalog[0])
  expect(selectDevinTestModel(catalog, 'swe-1-7-medium')).toBe(catalog[1])
})

it('rejects blank or unavailable models without echoing the supplied value', () => {
  expect(() => selectDevinTestModel(catalog, '')).toThrow('DEVIN_TEST_MODEL must not be blank')
  expect(() => selectDevinTestModel(catalog, ' \t')).toThrow('DEVIN_TEST_MODEL must not be blank')
  const privateValue = 'private-unavailable-model'
  let error: unknown
  try {
    selectDevinTestModel(catalog, privateValue)
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(Error)
  expect(String(error)).not.toContain(privateValue)
  expect(() => selectDevinTestModel([{ id: 'some-other-model' }], undefined)).toThrow(/unavailable/)
})

it('requires the live Lead and teammate routes to match the selected catalog model', () => {
  const route = {
    creationModelId: DEFAULT_DEVIN_TEST_MODEL,
    requestModelIds: [DEFAULT_DEVIN_TEST_MODEL],
  } as const
  // Persisted route evidence remains usable after a completed teammate is
  // disposed and removed from the live Agent registry.
  expect(() => assertDevinTeamModelRoutes(DEFAULT_DEVIN_TEST_MODEL, route, route)).not.toThrow()
  expect(() =>
    assertDevinTeamModelRoutes(DEFAULT_DEVIN_TEST_MODEL, { ...route, creationModelId: 'another-model' }, route),
  ).toThrow('Devin live-test Lead route must use the selected catalog model')
  expect(() => assertDevinTeamModelRoutes(DEFAULT_DEVIN_TEST_MODEL, route, undefined)).toThrow(
    'Devin live-test teammate route must use the selected catalog model',
  )
  expect(() =>
    assertDevinTeamModelRoutes(DEFAULT_DEVIN_TEST_MODEL, route, { ...route, requestModelIds: ['another-model'] }),
  ).toThrow('Devin live-test teammate route must use the selected catalog model')
  expect(() => assertDevinTeamModelRoutes(DEFAULT_DEVIN_TEST_MODEL, route, { ...route, requestModelIds: [] })).toThrow(
    'Devin live-test teammate route must include a real request header',
  )
})
