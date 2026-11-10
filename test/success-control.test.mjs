import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDailyResult } from '../lib/success-control.mjs';

test('daily result classification follows target CPA and avoids premature strategy changes', () => {
  const profile = { primary_kpi: 'cpa', target_value: '2 500 ₽' };
  assert.equal(classifyDailyResult(profile, { spend: 5000, conversions: 0 }).status, 'critical');
  assert.equal(classifyDailyResult(profile, { spend: 3000, conversions: 1 }).status, 'attention');
  const ok = classifyDailyResult(profile, { spend: 4000, conversions: 2 });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.cpa, 2000);
});
