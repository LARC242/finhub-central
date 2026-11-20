/* FinHub Household Settlement reconciliation core.
 * This module deliberately creates no transactions and posts no bank/account effects.
 * It only validates and summarizes links between existing ledger transactions.
 */
(function (root) {
  'use strict';

  const toCents = value => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 100) : NaN;
  };
  const active = record => !record?.reversedAt && record?.status !== 'void';

  function getTransaction(transactions, id) {
    return (transactions || []).find(t => String(t.id) === String(id));
  }

  function allocatedToBillCents(settlements, billId, excludeSettlementId = '') {
    return (settlements || []).filter(s => active(s) && String(s.id) !== String(excludeSettlementId))
      .reduce((sum, s) => sum + (s.allocations || [])
        .filter(a => String(a.jointBillId) === String(billId))
        .reduce((n, a) => n + Math.max(0, Number(a.amountCents) || 0), 0), 0);
  }

  function validateSettlement(input, context) {
    const errors = [];
    const transactions = context?.transactions || [];
    const bills = context?.jointBills || [];
    const settlements = context?.settlements || [];
    const bank = getTransaction(transactions, input?.bankTransactionId);

    if (!bank) errors.push('Select an existing e-transfer withdrawal from the ledger.');
    else {
      const bankType = String(bank.type || '').toLowerCase();
      if (!['expense', 'transfer'].includes(bankType)) errors.push('The linked bank transaction must be an existing expense or outgoing transfer.');
      if (bank.source === 'joint-household-settlement') errors.push('Legacy settlement-generated expenses cannot be reused as the underlying bank withdrawal.');
      if (input.accountId && String(bank.accountId) !== String(input.accountId)) errors.push('The selected withdrawal does not belong to the selected funding account.');
    }

    const bankCents = bank ? toCents(Math.abs(Number(bank.amount) || 0)) : NaN;
    if (!Number.isSafeInteger(bankCents) || bankCents <= 0) errors.push('The linked withdrawal must have a valid amount greater than zero.');

    if (!Array.isArray(input?.allocations) || !input.allocations.length) errors.push('Allocate the transfer to at least one household bill.');
    let allocationTotalCents = 0;
    const seen = new Set();

    (input?.allocations || []).forEach((allocation, index) => {
      const bill = bills.find(b => String(b.id) === String(allocation.jointBillId) && String(b.ym) === String(input.ym));
      if (!bill) { errors.push(`Allocation ${index + 1} refers to a missing household bill.`); return; }
      if (seen.has(String(bill.id))) errors.push(`Household bill "${bill.name}" appears more than once.`);
      seen.add(String(bill.id));

      const amount = Number(allocation.amountCents);
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        errors.push(`Allocation for "${bill.name}" must be a positive whole-cent amount.`);
        return;
      }
      allocationTotalCents += amount;

      const expense = getTransaction(transactions, allocation.expenseTransactionId);
      if (!expense) errors.push(`Link "${bill.name}" to its existing expense transaction.`);
      else if (String(expense.type || '').toLowerCase() !== 'expense') errors.push(`The linked transaction for "${bill.name}" is not an expense.`);

      const billShare = Math.max(0, toCents((Number(bill.amount) || 0) * (Number(bill.splitPct) || 0) / 100));
      const adjusted = (context?.jointAdjustments || []).filter(a => active(a) && String(a.billId) === String(bill.id) && String(a.ym) === String(bill.ym))
        .reduce((sum, a) => sum + (a.type === 'additional' ? 1 : -1) * Math.abs(Number(a.amountCents) || 0), 0);
      const obligationCents = Math.max(0, billShare + adjusted);
      const previouslyAllocated = allocatedToBillCents(settlements, bill.id, input.id);
      const remaining = Math.max(0, obligationCents - previouslyAllocated);
      if (amount > remaining) errors.push(`Allocation for "${bill.name}" exceeds its remaining share by ${((amount - remaining) / 100).toFixed(2)}.`);
    });

    if (Number.isSafeInteger(bankCents) && allocationTotalCents > bankCents) errors.push('Bill allocations cannot exceed the linked e-transfer withdrawal.');
    return {
      valid: errors.length === 0,
      errors,
      bankAmountCents: Number.isSafeInteger(bankCents) ? bankCents : 0,
      allocationTotalCents,
      creditCents: Number.isSafeInteger(bankCents) ? Math.max(0, bankCents - allocationTotalCents) : 0
    };
  }

  function summarizeSettlement(settlement, transactions) {
    const bank = getTransaction(transactions, settlement?.bankTransactionId);
    const bankAmountCents = bank ? Math.max(0, toCents(Math.abs(Number(bank.amount) || 0))) : 0;
    const allocationTotalCents = (settlement?.allocations || []).reduce((sum, a) => sum + Math.max(0, Number(a.amountCents) || 0), 0);
    const reversed = !active(settlement);
    return {
      bankAmountCents,
      allocationTotalCents,
      creditCents: reversed ? 0 : Math.max(0, bankAmountCents - allocationTotalCents),
      differenceCents: bankAmountCents - allocationTotalCents,
      reversed
    };
  }

  function creditBalanceCents(settlements, transactions) {
    return (settlements || []).filter(active).reduce((sum, settlement) => {
      const summary = summarizeSettlement(settlement, transactions);
      return sum + summary.creditCents;
    }, 0);
  }

  root.FinHubHouseholdSettlement = Object.freeze({
    toCents,
    validateSettlement,
    summarizeSettlement,
    allocatedToBillCents,
    creditBalanceCents
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
