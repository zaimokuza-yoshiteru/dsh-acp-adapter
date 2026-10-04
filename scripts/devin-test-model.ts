export const DEFAULT_DEVIN_TEST_MODEL = 'swe-2-high'

export interface DevinCatalogModel {
  readonly id: string
}

export interface DevinModelRouteEvidence {
  readonly creationModelId: string | undefined
  readonly requestModelIds: readonly (string | undefined)[]
}

/** Select exactly one model from Devin's authenticated catalog, with no fallback. */
export function selectDevinTestModel<T extends DevinCatalogModel>(
  models: readonly T[],
  requestedModel: string | undefined,
): T {
  if (requestedModel !== undefined && requestedModel.trim().length === 0) {
    throw new Error('DEVIN_TEST_MODEL must not be blank')
  }
  const modelId = requestedModel ?? DEFAULT_DEVIN_TEST_MODEL
  const model = models.find((entry) => entry.id === modelId)
  if (model === undefined) {
    throw new Error('Configured Devin live-test model is unavailable in the authenticated model catalog')
  }
  return model
}

/** Assert one live route uses the selected catalog model without echoing IDs. */
export function assertDevinModelRoute(
  role: 'Lead' | 'teammate',
  selectedModelId: string,
  actualModelId: string | undefined,
): void {
  if (actualModelId !== selectedModelId) {
    throw new Error(`Devin live-test ${role} route must use the selected catalog model`)
  }
}

/** Assert both live Team routes created and sent real requests with the selected model. */
export function assertDevinTeamModelRoutes(
  selectedModelId: string,
  lead: DevinModelRouteEvidence | undefined,
  teammate: DevinModelRouteEvidence | undefined,
): void {
  assertDevinModelRouteEvidence('Lead', selectedModelId, lead)
  assertDevinModelRouteEvidence('teammate', selectedModelId, teammate)
}

/** Validate persisted route facts, which remain available after an Agent is disposed. */
export function assertDevinModelRouteEvidence(
  role: 'Lead' | 'teammate',
  selectedModelId: string,
  evidence: DevinModelRouteEvidence | undefined,
): void {
  assertDevinModelRoute(role, selectedModelId, evidence?.creationModelId)
  if (evidence === undefined || evidence.requestModelIds.length === 0) {
    throw new Error(`Devin live-test ${role} route must include a real request header`)
  }
  for (const requestModelId of evidence.requestModelIds) {
    assertDevinModelRoute(role, selectedModelId, requestModelId)
  }
}
