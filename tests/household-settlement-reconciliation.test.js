const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/household-settlement-reconciliation.js');
const core = globalThis.FinHubHouseholdSettlement;

const transactions = [
  { id: 'bank-1', type: 'Expense', amount: 600, accountId: 'chequing' },
  { id: 'rent-expense', type: 'Expense', amount: 1180, accountId: 'chequing' },
  { id: 'hydro-expense', type: 'Expense', amount: 90, accountId: 'chequing' },
  { id: 'refund-1', type: 'Income', amount: 25, accountId: 'chequing' }
];
const jointBills = [
  { id: 'rent', ym: '2026-11', name: 'Rent', amount: 2360, splitPct: 50 },
  { id: 'hydro', ym: '2026-11', name: 'Hydro', amount: 180, splitPct: 50 }
];
const context = { transactions, jointBills, jointAdjustments: [], settlements: [] };

test('links existing withdrawal and bill expenses without creating transactions', () => {
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

test('prevents allocating more than remaining share across settlements', () => {
  const result = core.validateSettlement({
    id: 'settlement-2', ym: '2026-11', bankTransactionId: 'bank-1', accountId: 'chequing',
    allocations: [{ jointBillId: 'rent', expenseTransactionId: 'rent-expense', amountCents: 60000 }]
  }, { ...context, settlements: [{ id: 'settlement-1', allocations: [{ jointBillId: 'rent', amountCents: 50000 }] }] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('exceeds its remaining share')));
});

test('supports partial allocations and calculates remaining household share', () => {
  const result = core.validateSettlement({
    ym: '2026-11', bankTransactionId: 'bank-1', accountId: 'chequing',
    allocations: [{ jointBillId: 'rent', expenseTransactionId: 'rent-expense', amountCents: 25000 }]
  }, context);
  assert.equal(result.valid, true);
  assert.equal(result.allocationTotalCents, 25000);
  assert.deepEqual(core.billBalances(jointBills[0], [
    { id: 's1', allocations: [{ jointBillId: 'rent', amountCents: 25000 }] }
  ]), { obligationCents: 118000, settledCents: 25000, outstandingCents: 93000, overAllocatedCents: 0 });
});

test('calculates excess transfer as a receivable credit', () => {
  const settlement = { id: 's1', bankTransactionId: 'bank-1', allocations: [{ amountCents: 50000 }] };
  assert.deepEqual(core.summarizeSettlement(settlement, transactions), {
    bankAmountCents: 60000, allocationTotalCents: 50000, creditCents: 10000, differenceCents: 10000, reversed: false
  });
  assert.deepEqual(core.creditPositionCents([settlement], transactions), {
    grossCreditCents: 10000, appliedOrRefundedCents: 0, availableCreditCents: 10000, overAppliedCents: 0
  });
});

test('reduces available receivable for linked application or refund events', () => {
  const settlement = { id: 's1', bankTransactionId: 'bank-1', allocations: [{ amountCents: 50000 }] };
  const events = [{ id: 'credit-refund', type: 'refund', transactionId: 'refund-1', amountCents: 2500 }];
  const result = core.validateCreditEvent(events[0], { ...context, settlements: [settlement] });
  assert.equal(result.valid, true);
  assert.equal(core.creditPositionCents([settlement], transactions, events).availableCreditCents, 7500);
});

test('rejects a credit event that exceeds the available credit', () => {
  const settlement = { id: 's1', bankTransactionId: 'bank-1', allocations: [{ amountCents: 50000 }] };
  const result = core.validateCreditEvent({
    type: 'refund', transactionId: 'refund-1', amountCents: 15000
  }, { ...context, settlements: [settlement] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('exceeds the available')));
});

test('rejects duplicate use of one bank withdrawal', () => {
  const result = core.validateSettlement({
    ym: '2026-11', bankTransactionId: 'bank-1',
    allocations: [{ jointBillId: 'rent', expenseTransactionId: 'rent-expense', amountCents: 50000 }]
  }, { ...context, settlements: [{ id: 'old', bankTransactionId: 'bank-1', allocations: [] }] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('already linked')));
});

test('requires the expense transaction to belong to the linked Calendar bill', () => {
  const linkedContext = {
    ...context,
    jointBills: [{ ...jointBills[0], linkedCalendarBillId: 'calendar-rent-root' }],
    calendarBills: [{ id: 'calendar-rent-instance', recurrenceRootId: 'calendar-rent-root', type: 'expense', paymentTransactionIds: ['rent-expense'] }]
  };
  assert.equal(core.validateSettlement({
    ym: '2026-11', bankTransactionId: 'bank-1',
    allocations: [{ jointBillId: 'rent', expenseTransactionId: 'rent-expense', amountCents: 50000 }]
  }, linkedContext).valid, true);
  assert.equal(core.validateSettlement({
    ym: '2026-11', bankTransactionId: 'bank-1',
    allocations: [{ jointBillId: 'rent', expenseTransactionId: 'hydro-expense', amountCents: 50000 }]
  }, linkedContext).valid, false);
});

test('rejects legacy settlement-generated expenses as source withdrawals', () => {
  const result = core.validateSettlement({
    ym: '2026-11', bankTransactionId: 'legacy', allocations: []
  }, { ...context, transactions: [...transactions, { id: 'legacy', type: 'Expense', amount: 50, source: 'joint-household-settlement' }] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('cannot be reused')));
});

test('reversed settlements release their allocations and credit', () => {
  const reversed = { id: 's1', bankTransactionId: 'bank-1', reversedAt: '2026-11-20T00:00:00Z', allocations: [{ jointBillId: 'rent', amountCents: 50000 }] };
  assert.equal(core.allocatedToBillCents([reversed], 'rent'), 0);
  assert.equal(core.creditPositionCents([reversed], transactions).availableCreditCents, 0);
});


test('monthly position separates allocated bills from transfer credit', () => {
  const settlements = [{
    id: 's-month', ym: '2026-11', bankTransactionId: 'bank-1',
    allocations: [
      { jointBillId: 'rent', expenseTransactionId: 'rent-expense', amountCents: 50000 },
      { jointBillId: 'hydro', expenseTransactionId: 'hydro-expense', amountCents: 9000 }
    ]
  }];
  assert.deepEqual(core.settlementMonthPosition('2026-11', jointBills, settlements, transactions), {
    obligationsCents: 127000,
    settledCents: 59000,
    outstandingCents: 68000,
    overAllocatedCents: 0,
    transferCents: 60000,
    grossCreditCents: 1000,
    appliedOrRefundedCreditCents: 0,
    availableCreditCents: 1000
  });
});

test('month position ignores reversed settlements and their credit', () => {
  const settlements = [{
    id: 's-month', ym: '2026-11', bankTransactionId: 'bank-1', status: 'reversed',
    reversedAt: '2026-11-20T00:00:00Z',
    allocations: [{ jointBillId: 'rent', amountCents: 50000 }]
  }];
  const position = core.settlementMonthPosition('2026-11', jointBills, settlements, transactions);
  assert.equal(position.settledCents, 0);
  assert.equal(position.transferCents, 0);
  assert.equal(position.availableCreditCents, 0);
  assert.equal(position.outstandingCents, 127000);
});
