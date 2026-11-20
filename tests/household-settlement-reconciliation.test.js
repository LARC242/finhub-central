const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/household-settlement-reconciliation.js');
const core = globalThis.FinHubHouseholdSettlement;

const transactions = [
  { id: 'bank-1', type: 'Expense', amount: 600, accountId: 'chequing' },
  { id: 'rent-expense', type: 'Expense', amount: 1180, accountId: 'chequing' },
  { id: 'hydro-expense', type: 'Expense', amount: 90, accountId: 'chequing' }
];
const jointBills = [
  { id: 'rent', ym: '2026-11', name: 'Rent', amount: 2360, splitPct: 50 },
  { id: 'hydro', ym: '2026-11', name: 'Hydro', amount: 180, splitPct: 50 }
];
const context = { transactions, jointBills, jointAdjustments: [], settlements: [] };

test('links existing bank withdrawal and existing bill expenses without creating transactions', () => {
  const before = transactions.length;
  const result = core.validateSettlement({
    id: 'settlement-1', ym: '2026-11', bankTransactionId: 'bank-1', accountId: 'chequing',
    allocations: [
      { jointBillId: 'rent', expenseTransactionId: 'rent-expense', amountCents: 50000 },
      { jointBillId: 'hydro', expenseTransactionId: 'hydro-expense', amountCents: 9000 }
    ]
  }, context);
  assert.equal(result.valid, true);
  assert.equal(result.creditCents, 1000);
  assert.equal(transactions.length, before);
});

test('rejects missing or non-expense bill transaction links', () => {
  const result = core.validateSettlement({
    ym: '2026-11', bankTransactionId: 'bank-1', accountId: 'chequing',
    allocations: [{ jointBillId: 'rent', expenseTransactionId: 'bank-1', amountCents: 50000 }]
  }, context);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('not an expense')));
});

test('prevents allocating more than the remaining bill share across settlements', () => {
  const result = core.validateSettlement({
    id: 'settlement-2', ym: '2026-11', bankTransactionId: 'bank-1', accountId: 'chequing',
    allocations: [{ jointBillId: 'rent', expenseTransactionId: 'rent-expense', amountCents: 60000 }]
  }, { ...context, settlements: [{ id: 'settlement-1', allocations: [{ jointBillId: 'rent', amountCents: 50000 }] }] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('exceeds its remaining share')));
});

test('supports partial allocation and leaves the remainder outstanding to be derived by caller', () => {
  const result = core.validateSettlement({
    ym: '2026-11', bankTransactionId: 'bank-1', accountId: 'chequing',
    allocations: [{ jointBillId: 'rent', expenseTransactionId: 'rent-expense', amountCents: 25000 }]
  }, context);
  assert.equal(result.valid, true);
  assert.equal(result.allocationTotalCents, 25000);
});

test('calculates excess transfer as a receivable credit, not an expense', () => {
  const settlement = { id: 's1', bankTransactionId: 'bank-1', allocations: [{ amountCents: 50000 }] };
  assert.deepEqual(core.summarizeSettlement(settlement, transactions), {
    bankAmountCents: 60000, allocationTotalCents: 50000, creditCents: 10000, differenceCents: 10000, reversed: false
  });
  assert.equal(core.creditBalanceCents([settlement], transactions), 10000);
});

test('reversed settlement no longer contributes a credit balance', () => {
  const settlement = { id: 's1', bankTransactionId: 'bank-1', reversedAt: '2026-11-20T00:00:00Z', allocations: [{ amountCents: 50000 }] };
  assert.equal(core.creditBalanceCents([settlement], transactions), 0);
});

test('rejects legacy generated settlement expenses as source withdrawals', () => {
  const result = core.validateSettlement({
    ym: '2026-11', bankTransactionId: 'legacy', allocations: []
  }, { ...context, transactions: [...transactions, { id: 'legacy', type: 'Expense', amount: 50, source: 'joint-household-settlement' }] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('cannot be reused')));
});
