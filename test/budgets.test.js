import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapBudget, budgetLevel, mapAnomaly } from '../server/budgets.js'

test('mapBudget: consumo e proiezione sono DUE percentuali, non una', () => {
  const out = mapBudget({
    BudgetName: 'llms-monthly',
    BudgetType: 'COST',
    TimeUnit: 'MONTHLY',
    BudgetLimit: { Amount: '1500', Unit: 'USD' },
    CalculatedSpend: { ActualSpend: { Amount: '980' }, ForecastedSpend: { Amount: '1840' } },
  })
  assert.equal(out.name, 'llms-monthly')
  assert.equal(out.limit, 1500)
  assert.equal(out.actual, 980)
  assert.equal(out.actualPct, 65)
  assert.equal(out.forecastPct, 123)
})

test('mapBudget: campi mancanti → null, mai NaN (un NaN in pagina si legge come un bug)', () => {
  const out = mapBudget({ BudgetName: 'vuoto' })
  assert.equal(out.limit, null)
  assert.equal(out.actual, null)
  assert.equal(out.actualPct, null)
  assert.equal(out.forecastPct, null)
})

test('budgetLevel: la proiezione oltre il limite pesa come lo sforamento già avvenuto', () => {
  assert.equal(budgetLevel({ actualPct: 110, forecastPct: 130 }), 'over')
  // il caso che conta: consumo tranquillo, proiezione fuori → si interviene ADESSO
  assert.equal(budgetLevel({ actualPct: 65, forecastPct: 123 }), 'willOver')
  assert.equal(budgetLevel({ actualPct: 85, forecastPct: 90 }), 'warn')
  assert.equal(budgetLevel({ actualPct: 40, forecastPct: 95 }), 'warn')
  assert.equal(budgetLevel({ actualPct: 30, forecastPct: 70 }), 'ok')
  assert.equal(budgetLevel({}), 'ok')
})

test('mapAnomaly: impatto, causa principale e feedback', () => {
  const out = mapAnomaly({
    AnomalyId: 'a1',
    AnomalyStartDate: '2026-08-06T00:00:00Z',
    Impact: { TotalImpact: 412.5, TotalExpectedSpend: 180.2, TotalActualSpend: 592.7 },
    RootCauses: [{ Service: 'Amazon Bedrock', Region: 'eu-central-1', LinkedAccountName: 'Production', UsageType: 'EUC1-InputTokenCount' }],
    Feedback: 'YES',
  })
  assert.equal(out.service, 'Amazon Bedrock')
  assert.equal(out.account, 'Production')
  assert.equal(out.impact, 412.5)
  assert.equal(out.impactPct, 229)
  assert.equal(out.feedback, 'YES')
})

test('mapAnomaly: senza RootCauses non inventa la causa', () => {
  const out = mapAnomaly({ AnomalyId: 'a2', Impact: { TotalImpact: 5 } })
  assert.equal(out.service, null)
  assert.equal(out.account, null)
  assert.equal(out.impactPct, null)
})
