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
    if (!expense) return false;
    const rootId = String(jointBill.linkedCalendarBillId);
    const candidates = (context?.calendarBills || []).filter(b => b && b.type === 'expense' &&
      (String(b.id) === rootId || String(b.recurrenceRootId || '') === rootId));
    return candidates.some(calendarBill => {
      const paymentIds = new Set([
        ...(Array.isArray(calendarBill.paymentTransactionIds) ? calendarBill.paymentTransactionIds : []),
        calendarBill.linkedTransactionId,
        ...(context?.transactions || []).filter(t => String(t.calendarBillId || '') === String(calendarBill.id)).map(t => t.id)
      ].filter(Boolean).map(String));
      if (!paymentIds.has(String(expense.id))) return false;
      if (expense.calendarBillId && String(expense.calendarBillId) !== String(calendarBill.id)) return false;
      // If the household bill has an occurrence date, require the matching calendar occurrence.
      if (jointBill.date && calendarBill.date && String(jointBill.date) !== String(calendarBill.date)) return false;
      return true;
    });
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
      const bankDescription = [bank.vendor, bank.desc, bank.description, bank.notes].filter(Boolean).join(' ').toLowerCase();
      const explicitETransferExpense = bankType === 'expense' && /\b(e[ -]?transfer|etransfer)\b/i.test(bankDescription);
      const externalTransferOut = bankType === 'transfer' && bank.externalTransferDirection === 'out' && !bank.transferToAccountId;
      if (!explicitETransferExpense && !externalTransferOut) {
        errors.push('The linked transaction must be an existing external e-Transfer withdrawal, not an ordinary purchase or internal account transfer.');
      }
      if (bank.source === 'joint-household-settlement') errors.push('Legacy settlement-generated expenses cannot be reused as the underlying bank withdrawal.');
      if (!(Number(bank.amount) > 0)) errors.push('The linked e-Transfer must be a positive withdrawal, not a refund or credit.');
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
    const expenseAllocationInInput = new Map();
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
      if (String(allocation.expenseTransactionId) === String(input?.bankTransactionId)) errors.push('The e-Transfer withdrawal cannot also be used as the household bill expense.');
      if (!expense) errors.push(`Link "${bill.name}" to its existing expense transaction.`);
      else {
        if (String(expense.type || '').toLowerCase() !== 'expense') errors.push(`The linked transaction for "${bill.name}" is not an expense.`);
        if (!(Number(expense.amount) > 0)) errors.push(`The linked transaction for "${bill.name}" must be a positive bill expense, not a refund or credit.`);
        const expenseId = String(expense.id);
        const priorExpenseAllocation = (settlements || []).filter(item => active(item) && String(item.id) !== String(input?.id))
          .reduce((sum, item) => sum + (item.allocations || []).filter(a => String(a.expenseTransactionId) === expenseId)
            .reduce((n, a) => n + Math.max(0, Number(a.amountCents) || 0), 0), 0);
        const currentExpenseAllocation = expenseAllocationInInput.get(expenseId) || 0;
        const expenseCents = Math.max(0, toCents(Math.abs(Number(expense.amount) || 0)));
        if (amount > Math.max(0, expenseCents - priorExpenseAllocation - currentExpenseAllocation)) {
          errors.push(`Allocations linked to the expense for "${bill.name}" exceed the remaining amount of that expense transaction.`);
        }
        expenseAllocationInInput.set(expenseId, currentExpenseAllocation + amount);
        if (expense.refundOfTransactionId || expense.isReversal || expense.reversalOfTransactionId || expense.reconciledDuplicate) errors.push(`The linked transaction for "${bill.name}" is a refund, reversal or duplicate.`);
        // A Calendar-linked bill may still be reconciled when the original expense
      // was recorded manually and was never linked back to the Calendar item.
      // In that case, require the expense to fall within the household bill month.
      if (!linkedCalendarExpenseIsValid(bill, expense, context) &&
          (!expense.date || String(expense.date).slice(0, 7) !== String(bill.ym))) {
        errors.push(`The linked transaction for "${bill.name}" must be a payment recorded against its Calendar bill or an expense dated in the same household month.`);
      }
      }
      const shareCents = Math.max(0, Math.round(toCents(Number(bill.amount) || 0) * (Number(bill.splitPct) || 0) / 100));
      const adjustmentCents = (context?.jointAdjustments || []).filter(a => active(a) && String(a.billId) === String(bill.id) && String(a.ym) === String(bill.ym))
        .reduce((sum, a) => sum + (a.type === 'additional' ? 1 : -1) * Math.abs(Number(a.amountCents) || 0), 0);
      const obligationCents = Math.max(0, shareCents + adjustmentCents);
      const remaining = Math.max(0, obligationCents - allocatedToBillCents(settlements, bill.id, input.id) - appliedCreditToBillCents(context?.creditEvents, bill.id));
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

  function appliedCreditToBillCents(creditEvents, billId, excludeCreditEventId = '') {
    return (creditEvents || []).filter(event => active(event) && event.type === 'application' &&
      String(event.jointBillId) === String(billId) && String(event.id) !== String(excludeCreditEventId))
      .reduce((sum, event) => sum + Math.max(0, Number(event.amountCents) || 0), 0);
  }

  function billBalances(jointBill, settlements, adjustments = [], creditEvents = []) {
    const shareCents = Math.max(0, Math.round(toCents(Number(jointBill.amount) || 0) * (Number(jointBill.splitPct) || 0) / 100));
    const adjustmentCents = (adjustments || []).filter(a => active(a) && String(a.billId) === String(jointBill.id) && String(a.ym) === String(jointBill.ym))
      .reduce((sum, a) => sum + (a.type === 'additional' ? 1 : -1) * Math.abs(Number(a.amountCents) || 0), 0);
    const obligationCents = Math.max(0, shareCents + adjustmentCents);
    const settledCents = allocatedToBillCents(settlements, jointBill.id) + appliedCreditToBillCents(creditEvents, jointBill.id);
    return { obligationCents, settledCents, outstandingCents: Math.max(0, obligationCents - settledCents), overAllocatedCents: Math.max(0, settledCents - obligationCents) };
  }

  function creditPositionCents(settlements, transactions, creditEvents = []) {
    const activeSettlements = (settlements || []).filter(active);
    const activeSettlementIds = new Set(activeSettlements.map(s => String(s.id)));
    const grossCredit = activeSettlements.reduce((sum, s) => sum + summarizeSettlement(s, transactions).creditCents, 0);
    // A refund/application is only live while the settlement that created the credit remains active.
    const appliedOrRefunded = (creditEvents || []).filter(e => active(e) && activeSettlementIds.has(String(e.settlementId)))
      .reduce((sum, e) => sum + Math.max(0, Number(e.amountCents) || 0), 0);
    return { grossCreditCents: grossCredit, appliedOrRefundedCents: appliedOrRefunded,
      availableCreditCents: Math.max(0, grossCredit - appliedOrRefunded),
      overAppliedCents: Math.max(0, appliedOrRefunded - grossCredit) };
  }


  function settlementMonthPosition(ym, jointBills, settlements, transactions, adjustments = [], creditEvents = []) {
    const bills = (jointBills || []).filter(b => String(b.ym) === String(ym));
    const obligationsCents = bills.reduce((sum, bill) => sum + billBalances(bill, settlements, adjustments, creditEvents).obligationCents, 0);
    const settledCents = bills.reduce((sum, bill) => sum + billBalances(bill, settlements, adjustments, creditEvents).settledCents, 0);
    const outstandingCents = bills.reduce((sum, bill) => sum + billBalances(bill, settlements, adjustments, creditEvents).outstandingCents, 0);
    const overAllocatedCents = bills.reduce((sum, bill) => sum + billBalances(bill, settlements, adjustments, creditEvents).overAllocatedCents, 0);
    const monthSettlements = (settlements || []).filter(s => active(s) && String(s.ym) === String(ym));
    const transferCents = monthSettlements.reduce((sum, settlement) => sum + summarizeSettlement(settlement, transactions).bankAmountCents, 0);
    const monthSettlementIds = new Set(monthSettlements.map(s => String(s.id)));
    const monthEvents = (creditEvents || []).filter(event => monthSettlementIds.has(String(event.settlementId)));
    const monthCredits = creditPositionCents(monthSettlements, transactions, monthEvents);
    return { obligationsCents, settledCents, outstandingCents, overAllocatedCents, transferCents,
      grossCreditCents: monthCredits.grossCreditCents, appliedOrRefundedCreditCents: monthCredits.appliedOrRefundedCents,
      availableCreditCents: monthCredits.availableCreditCents };
  }

  function validateCreditEvent(event, context) {
    const errors = [];
    const available = creditPositionCents(context?.settlements, context?.transactions, context?.creditEvents).availableCreditCents;
    const amount = Number(event?.amountCents);
    const sourceSettlement = (context?.settlements || []).find(item => String(item.id) === String(event?.settlementId) && active(item));
    if (!sourceSettlement) errors.push('Select the active settlement that created this credit.');
    if (!['refund', 'application'].includes(String(event?.type || ''))) errors.push('Credit event type must be refund or application.');
    if (!Number.isSafeInteger(amount) || amount <= 0) errors.push('Enter a positive credit amount in whole cents.');
    else if (amount > available) errors.push('The credit event exceeds the available household settlement credit.');
    if (sourceSettlement && Number.isSafeInteger(amount)) {
      const sourceCredit = summarizeSettlement(sourceSettlement, context?.transactions || []).creditCents;
      const alreadyUsed = (context?.creditEvents || []).filter(e => active(e) && String(e.settlementId) === String(sourceSettlement.id) && String(e.id) !== String(event?.id)).reduce((sum,e)=>sum+Math.max(0,Number(e.amountCents)||0),0);
      if (alreadyUsed + amount > sourceCredit) errors.push('The credit event exceeds the unused credit from the selected settlement.');
    }
    const tx = getTransaction(context?.transactions, event?.transactionId);
    if (!tx) errors.push('Link the credit event to its existing ledger transaction.');
    else if (event.type === 'refund' && String(tx.type).toLowerCase() !== 'income') errors.push('A partner refund must link to an existing income/deposit transaction.');
    else if (event.type === 'application' && String(tx.type).toLowerCase() !== 'expense') errors.push('A credit application must link to an existing household expense transaction.');
    if (event?.type === 'application') {
      const bill = getBill(context?.jointBills, event.jointBillId);
      if (!bill) errors.push('Select the household bill that receives this credit application.');
      else if (tx && !linkedCalendarExpenseIsValid(bill, tx, context) &&
        (!tx.date || String(tx.date).slice(0, 7) !== String(bill.ym))) {
        errors.push('The linked expense must belong to the selected Calendar bill or be dated in the same household month.');
      }
      if (bill && tx) {
        const balance = billBalances(bill, context?.settlements || [], context?.jointAdjustments || [], context?.creditEvents || []);
        if (Number.isSafeInteger(amount) && amount > balance.outstandingCents) errors.push('The credit application exceeds the remaining household bill share.');
      }
    }
    return { valid: errors.length === 0, errors, availableCreditCents: available };
  }


  function createSettlement(state, input, now = new Date().toISOString()) {
    state.householdSettlements = Array.isArray(state.householdSettlements) ? state.householdSettlements : [];
    const context = {
      transactions: state.transactions || [], jointBills: state.jointBills || [],
      calendarBills: state.calendarBills || [], jointAdjustments: state.jointAdjustments || [],
      settlements: state.householdSettlements,
      creditEvents: state.householdSettlementCreditEvents || []
    };
    const validation = validateSettlement(input, context);
    if (!validation.valid) return { saved: false, validation };
    const record = {
      id: input.id || `hhs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      ym: String(input.ym),
      date: String(input.date || ''),
      bankTransactionId: String(input.bankTransactionId),
      accountId: String(input.accountId || getTransaction(context.transactions, input.bankTransactionId)?.accountId || ''),
      allocations: input.allocations.map(a => ({
        jointBillId: String(a.jointBillId),
        expenseTransactionId: String(a.expenseTransactionId),
        amountCents: Number(a.amountCents)
      })),
      createdAt: now,
      status: 'active'
    };
    state.householdSettlements.push(record);
    return { saved: true, record, validation };
  }

  function reverseSettlement(state, settlementId, reason, now = new Date().toISOString()) {
    const record = (state.householdSettlements || []).find(s => String(s.id) === String(settlementId));
    if (!record || !active(record)) return { reversed: false, error: 'Active settlement not found.' };
    record.reversedAt = now;
    record.reversalReason = String(reason || '').trim();
    record.status = 'reversed';
    // Credit events cannot outlive the settlement that created their receivable.
    (state.householdSettlementCreditEvents || []).forEach(event => {
      if (String(event.settlementId) !== String(record.id) || !active(event)) return;
      event.reversedAt = now;
      event.reversalReason = 'Source settlement reversed' + (record.reversalReason ? ': ' + record.reversalReason : '');
      event.status = 'reversed';
    });
    return { reversed: true, record };
  }

  function createCreditEvent(state, input, now = new Date().toISOString()) {
    state.householdSettlementCreditEvents = Array.isArray(state.householdSettlementCreditEvents) ? state.householdSettlementCreditEvents : [];
    const context = {
      settlements: state.householdSettlements || [], transactions: state.transactions || [],
      jointBills: state.jointBills || [], calendarBills: state.calendarBills || [],
      jointAdjustments: state.jointAdjustments || [], creditEvents: state.householdSettlementCreditEvents
    };
    const validation = validateCreditEvent(input, context);
    if (!validation.valid) return { saved: false, validation };
    const record = {
      id: input.id || `hhc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      type: input.type,
      transactionId: String(input.transactionId),
      settlementId: String(input.settlementId),
      amountCents: Number(input.amountCents),
      jointBillId: input.jointBillId ? String(input.jointBillId) : '',
      createdAt: now,
      status: 'active'
    };
    state.householdSettlementCreditEvents.push(record);
    return { saved: true, record, validation };
  }

  function reverseCreditEvent(state, creditEventId, reason, now = new Date().toISOString()) {
    const record = (state.householdSettlementCreditEvents || []).find(event => String(event.id) === String(creditEventId));
    if (!record || !active(record)) return { reversed: false, error: 'Active credit event not found.' };
    record.reversedAt = now;
    record.reversalReason = String(reason || '').trim();
    record.status = 'reversed';
    return { reversed: true, record };
  }

  root.FinHubHouseholdSettlement = Object.freeze({
    toCents, validateSettlement, summarizeSettlement, allocatedToBillCents, appliedCreditToBillCents,
    billBalances, creditPositionCents, settlementMonthPosition, validateCreditEvent,
    createSettlement, reverseSettlement, createCreditEvent, reverseCreditEvent
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
