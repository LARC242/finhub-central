/* FinHub Household Settlement reconciliation core.
 * Associations only: this module never creates transactions or posts account effects.
 */
(function (root) {
  'use strict';
  const toCents = value => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 100) : NaN;
  };
  const active = record => !record?.reversedAt && record?.status !== 'void';
  const getTransaction = (transactions, id) => (transactions || []).find(t => String(t.id) === String(id));
  const getBill = (bills, id, ym) => (bills || []).find(b => String(b.id) === String(id) && (!ym || String(b.ym) === String(ym)));

  function allocatedToBillCents(settlements, billId, excludeSettlementId = '') {
    return (settlements || []).filter(s => active(s) && String(s.id) !== String(excludeSettlementId))
      .reduce((sum, s) => sum + (s.allocations || []).filter(a => String(a.jointBillId) === String(billId))
        .reduce((n, a) => n + Math.max(0, Number(a.amountCents) || 0), 0), 0);
  }

  function linkedCalendarExpenseIsValid(jointBill, expense, context) {
    if (!jointBill?.linkedCalendarBillId) return true;
    const calendarBills = context?.calendarBills || [];
    const calendarBill = calendarBills.find(b => b && b.type === 'expense' &&
      (String(b.id) === String(jointBill.linkedCalendarBillId) ||
       String(b.recurrenceRootId || '') === String(jointBill.linkedCalendarBillId)));
    if (!calendarBill || !expense) return false;
    const paymentIds = new Set([
      ...(Array.isArray(calendarBill.paymentTransactionIds) ? calendarBill.paymentTransactionIds : []),
      calendarBill.linkedTransactionId,
      ...(context?.transactions || []).filter(t => String(t.calendarBillId || '') === String(calendarBill.id)).map(t => t.id)
    ].filter(Boolean).map(String));
    if (!paymentIds.has(String(expense.id))) return false;
    if (expense.calendarBillId && String(expense.calendarBillId) !== String(calendarBill.id)) return false;
    return true;
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
      if (bankType !== 'expense' && !(bankType === 'transfer' && bank.externalTransferDirection !== 'in' && !bank.transferToAccountId)) {
        errors.push('The linked transaction must be an existing external e-transfer withdrawal.');
      }
      if (bank.source === 'joint-household-settlement') errors.push('Legacy settlement-generated expenses cannot be reused as the underlying bank withdrawal.');
      if (input.accountId && String(bank.accountId) !== String(input.accountId)) errors.push('The selected withdrawal does not belong to the selected funding account.');
      if (bank.refundOfTransactionId || bank.isReversal || bank.reversalOfTransactionId || bank.reconciledDuplicate) errors.push('Refunds, reversals and duplicate transactions cannot be used as the original e-transfer.');
    }
    const bankCents = bank ? toCents(Math.abs(Number(bank.amount) || 0)) : NaN;
    if (!Number.isSafeInteger(bankCents) || bankCents <= 0) errors.push('The linked withdrawal must have a valid amount greater than zero.');
    if ((settlements || []).some(s => active(s) && String(s.bankTransactionId) === String(input?.bankTransactionId) && String(s.id) !== String(input?.id))) {
      errors.push('This bank withdrawal is already linked to another household settlement.');
    }

    if (!Array.isArray(input?.allocations) || !input.allocations.length) errors.push('Allocate the transfer to at least one household bill.');
    let allocationTotalCents = 0;
    const seen = new Set();
    (input?.allocations || []).forEach((allocation, index) => {
      const bill = getBill(bills, allocation.jointBillId, input.ym);
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
      else {
        if (String(expense.type || '').toLowerCase() !== 'expense') errors.push(`The linked transaction for "${bill.name}" is not an expense.`);
        if (expense.refundOfTransactionId || expense.isReversal || expense.reversalOfTransactionId || expense.reconciledDuplicate) errors.push(`The linked transaction for "${bill.name}" is a refund, reversal or duplicate.`);
        if (!linkedCalendarExpenseIsValid(bill, expense, context)) errors.push(`The linked transaction for "${bill.name}" is not a payment recorded against its linked Calendar bill.`);
      }
      const shareCents = Math.max(0, toCents((Number(bill.amount) || 0) * (Number(bill.splitPct) || 0) / 100));
      const adjustmentCents = (context?.jointAdjustments || []).filter(a => active(a) && String(a.billId) === String(bill.id) && String(a.ym) === String(bill.ym))
        .reduce((sum, a) => sum + (a.type === 'additional' ? 1 : -1) * Math.abs(Number(a.amountCents) || 0), 0);
      const obligationCents = Math.max(0, shareCents + adjustmentCents);
      const remaining = Math.max(0, obligationCents - allocatedToBillCents(settlements, bill.id, input.id));
      if (amount > remaining) errors.push(`Allocation for "${bill.name}" exceeds its remaining share by ${((amount - remaining) / 100).toFixed(2)}.`);
    });
    if (Number.isSafeInteger(bankCents) && allocationTotalCents > bankCents) errors.push('Bill allocations cannot exceed the linked e-transfer withdrawal.');
    return { valid: errors.length === 0, errors, bankAmountCents: Number.isSafeInteger(bankCents) ? bankCents : 0,
      allocationTotalCents, creditCents: Number.isSafeInteger(bankCents) ? Math.max(0, bankCents - allocationTotalCents) : 0 };
  }

  function summarizeSettlement(settlement, transactions) {
    const bank = getTransaction(transactions, settlement?.bankTransactionId);
    const bankAmountCents = bank ? Math.max(0, toCents(Math.abs(Number(bank.amount) || 0))) : 0;
    const allocationTotalCents = (settlement?.allocations || []).reduce((sum, a) => sum + Math.max(0, Number(a.amountCents) || 0), 0);
    const reversed = !active(settlement);
    return { bankAmountCents, allocationTotalCents, creditCents: reversed ? 0 : Math.max(0, bankAmountCents - allocationTotalCents),
      differenceCents: bankAmountCents - allocationTotalCents, reversed };
  }

  function billBalances(jointBill, settlements, adjustments = []) {
    const shareCents = Math.max(0, toCents((Number(jointBill.amount) || 0) * (Number(jointBill.splitPct) || 0) / 100));
    const adjustmentCents = (adjustments || []).filter(a => active(a) && String(a.billId) === String(jointBill.id) && String(a.ym) === String(jointBill.ym))
      .reduce((sum, a) => sum + (a.type === 'additional' ? 1 : -1) * Math.abs(Number(a.amountCents) || 0), 0);
    const obligationCents = Math.max(0, shareCents + adjustmentCents);
    const settledCents = allocatedToBillCents(settlements, jointBill.id);
    return { obligationCents, settledCents, outstandingCents: Math.max(0, obligationCents - settledCents), overAllocatedCents: Math.max(0, settledCents - obligationCents) };
  }

  function creditPositionCents(settlements, transactions, creditEvents = []) {
    const grossCredit = (settlements || []).filter(active).reduce((sum, s) => sum + summarizeSettlement(s, transactions).creditCents, 0);
    const appliedOrRefunded = (creditEvents || []).filter(active).reduce((sum, e) => sum + Math.max(0, Number(e.amountCents) || 0), 0);
    return { grossCreditCents: grossCredit, appliedOrRefundedCents: appliedOrRefunded,
      availableCreditCents: Math.max(0, grossCredit - appliedOrRefunded),
      overAppliedCents: Math.max(0, appliedOrRefunded - grossCredit) };
  }

  function validateCreditEvent(event, context) {
    const errors = [];
    const available = creditPositionCents(context?.settlements, context?.transactions, context?.creditEvents).availableCreditCents;
    const amount = Number(event?.amountCents);
    if (!Number.isSafeInteger(amount) || amount <= 0) errors.push('Enter a positive credit amount in whole cents.');
    else if (amount > available) errors.push('The credit event exceeds the available household settlement credit.');
    const tx = getTransaction(context?.transactions, event?.transactionId);
    if (!tx) errors.push('Link the credit event to its existing ledger transaction.');
    else if (event.type === 'refund' && String(tx.type).toLowerCase() !== 'income') errors.push('A partner refund must link to an existing income/deposit transaction.');
    else if (event.type === 'application' && !['expense', 'transfer'].includes(String(tx.type).toLowerCase())) errors.push('A credit application must link to the existing transaction for the household expense it covers.');
    return { valid: errors.length === 0, errors, availableCreditCents: available };
  }

  root.FinHubHouseholdSettlement = Object.freeze({
    toCents, validateSettlement, summarizeSettlement, allocatedToBillCents,
    billBalances, creditPositionCents, validateCreditEvent
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
