/* FinHub Household Settlement reconciliation UI.
 * Links existing ledger transactions only. It never creates bank or expense transactions.
 */
(function (root) {
  'use strict';

  const core = root.FinHubHouseholdSettlement;
  const byId = id => document.getElementById(id);
  const cents = value => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) : NaN;
  };
  const money = value => {
    const amount = Number(value || 0) / 100;
    if (Math.abs(amount) < 0.00001) return '$0.00';
    return typeof root.formatFinancial === 'function'
      ? root.formatFinancial(amount)
      : '$' + amount.toFixed(2);
  };
  const esc = value => typeof root.escapeHtml === 'function'
    ? root.escapeHtml(String(value ?? ''))
    : String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const active = record => !!record && !record.reversedAt && record.status !== 'void' && record.status !== 'reversed';
  const monthOf = value => String(value || '').slice(0, 7);
  const currentMonth = () => state.selectedJointYM || new Date().toISOString().slice(0, 7);
  const transactions = () => Array.isArray(state.transactions) ? state.transactions : [];
  const settlements = () => Array.isArray(state.householdSettlements) ? state.householdSettlements : [];
  const creditEvents = () => Array.isArray(state.householdSettlementCreditEvents) ? state.householdSettlementCreditEvents : [];
  const billsForMonth = ym => (state.jointBills || []).filter(b => String(b.ym) === String(ym));

  function transactionLabel(tx) {
    const account = (state.accounts || []).find(a => String(a.id) === String(tx.accountId));
    const who = tx.vendor || tx.desc || 'Unnamed transaction';
    return [tx.date || 'No date', who, account?.name || 'Account unavailable', money(cents(Math.abs(Number(tx.amount) || 0)))].join(' · ');
  }

  function eligibleBankWithdrawals(ym) {
    return transactions().filter(tx => {
      const type = String(tx.type || '').toLowerCase();
      const validType = type === 'expense' || (type === 'transfer' && tx.externalTransferDirection !== 'in' && !tx.transferToAccountId);
      return validType && monthOf(tx.date) === String(ym) && Number(tx.amount) > 0 &&
        !tx.refundOfTransactionId && !tx.isReversal && !tx.reversalOfTransactionId && !tx.reconciledDuplicate &&
        tx.source !== 'joint-household-settlement';
    }).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }

  function expenseCandidates(bill, ym) {
    const allExpenses = transactions().filter(tx => String(tx.type || '').toLowerCase() === 'expense' &&
      Number(tx.amount) > 0 && !tx.refundOfTransactionId && !tx.isReversal && !tx.reversalOfTransactionId &&
      !tx.reconciledDuplicate && tx.source !== 'joint-household-settlement');
    if (bill?.linkedCalendarBillId) {
      const rootId = String(bill.linkedCalendarBillId);
      const calendarBills = (state.calendarBills || []).filter(item => item && item.type === 'expense' &&
        (String(item.id) === rootId || String(item.recurrenceRootId || '') === rootId));
      const ids = new Set();
      calendarBills.forEach(item => {
        (item.paymentTransactionIds || []).forEach(id => ids.add(String(id)));
        if (item.linkedTransactionId) ids.add(String(item.linkedTransactionId));
        allExpenses.filter(tx => String(tx.calendarBillId || '') === String(item.id)).forEach(tx => ids.add(String(tx.id)));
      });
      return allExpenses.filter(tx => ids.has(String(tx.id)));
    }
    return allExpenses.filter(tx => monthOf(tx.date) === String(ym));
  }

  function updateSettlementAllocationTotals() {
    const bank = transactions().find(tx => String(tx.id) === String(byId('hhs-bank-transaction')?.value));
    const bankCents = bank ? cents(Math.abs(Number(bank.amount) || 0)) : 0;
    const rows = [...document.querySelectorAll('#hhs-allocation-rows [data-hhs-bill-id]')];
    const allocated = rows.reduce((sum, row) => sum + Math.max(0, cents(row.querySelector('.hhs-allocation-amount')?.value) || 0), 0);
    const credit = Math.max(0, bankCents - allocated);
    const difference = bankCents - allocated;
    if (byId('hhs-bank-total')) byId('hhs-bank-total').textContent = money(bankCents);
    if (byId('hhs-allocation-total')) byId('hhs-allocation-total').textContent = money(allocated);
    if (byId('hhs-credit-preview')) {
      byId('hhs-credit-preview').textContent = difference >= 0
        ? 'Potential household credit: ' + money(credit)
        : 'Allocations exceed withdrawal by ' + money(Math.abs(difference));
      byId('hhs-credit-preview').className = 'text-xs font-semibold ' + (difference >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600');
    }
  }

  function renderAllocationRows(ym) {
    const host = byId('hhs-allocation-rows');
    if (!host) return;
    host.innerHTML = '';
    const monthBills = billsForMonth(ym);
    if (!monthBills.length) {
      host.innerHTML = '<p class="text-xs text-gray-500">There are no household bills for this month.</p>';
      return;
    }
    monthBills.forEach(bill => {
      const balance = core.billBalances(bill, settlements(), state.jointAdjustments || [], creditEvents());
      const options = expenseCandidates(bill, ym);
      const row = document.createElement('div');
      row.className = 'grid grid-cols-1 lg:grid-cols-[minmax(9rem,1fr)_minmax(13rem,1.7fr)_7rem] gap-2 items-center rounded-xl border border-gray-200 dark:border-gray-800 p-3';
      row.dataset.hhsBillId = String(bill.id);
      row.innerHTML = `
        <div class="min-w-0">
          <div class="font-semibold text-xs">${esc(bill.name)}</div>
          <div class="text-[10px] text-gray-500">Your share: ${esc(Number(bill.splitPct) || 0)}% · Remaining: ${esc(money(balance.outstandingCents))}</div>
        </div>
        <select class="hhs-expense-transaction w-full min-w-0 bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-2 text-xs" aria-label="Existing expense transaction for ${esc(bill.name)}">
          <option value="">Choose existing bill expense</option>
          ${options.map(tx => `<option value="${esc(tx.id)}">${esc(transactionLabel(tx))}</option>`).join('')}
        </select>
        <input class="hhs-allocation-amount w-full min-w-0 bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-2 text-xs text-right accounting-num" type="number" min="0" step="0.01" value="0.00" aria-label="Amount allocated to ${esc(bill.name)}"/>
      `;
      host.appendChild(row);
      row.querySelector('.hhs-allocation-amount').addEventListener('input', updateSettlementAllocationTotals);
      row.querySelector('.hhs-expense-transaction').addEventListener('change', updateSettlementAllocationTotals);
    });
  }

  function openHouseholdSettlementModal() {
    if (!core) { alert('Household Settlement reconciliation could not load. Refresh the app and try again.'); return; }
    const ym = currentMonth();
    const bankOptions = eligibleBankWithdrawals(ym);
    if (!bankOptions.length) {
      alert('No eligible existing withdrawals were found for ' + ym + '. Import or record the e-Transfer withdrawal in the ledger first, then reconcile it here.');
      return;
    }
    if (byId('hhs-settlement-month')) byId('hhs-settlement-month').value = ym;
    const bankSelect = byId('hhs-bank-transaction');
    bankSelect.innerHTML = '<option value="">Choose an existing e-Transfer withdrawal</option>' +
      bankOptions.map(tx => '<option value="' + esc(tx.id) + '">' + esc(transactionLabel(tx)) + '</option>').join('');
    bankSelect.onchange = updateSettlementAllocationTotals;
    renderAllocationRows(ym);
    byId('household-settlement-errors')?.classList.add('hidden');
    byId('household-settlement-modal')?.classList.remove('hidden');
    updateSettlementAllocationTotals();
  }

  function closeHouseholdSettlementModal() {
    byId('household-settlement-modal')?.classList.add('hidden');
  }

  function saveHouseholdSettlement() {
    const ym = byId('hhs-settlement-month')?.value || currentMonth();
    const bankTransactionId = String(byId('hhs-bank-transaction')?.value || '');
    const bank = transactions().find(tx => String(tx.id) === bankTransactionId);
    const rows = [...document.querySelectorAll('#hhs-allocation-rows [data-hhs-bill-id]')];
    const allocations = rows.map(row => ({
      jointBillId: String(row.dataset.hhsBillId),
      expenseTransactionId: String(row.querySelector('.hhs-expense-transaction')?.value || ''),
      amountCents: cents(row.querySelector('.hhs-allocation-amount')?.value)
    })).filter(item => Number.isSafeInteger(item.amountCents) && item.amountCents > 0);
    const input = {
      ym,
      date: bank?.date || '',
      bankTransactionId,
      accountId: bank?.accountId || '',
      allocations
    };
    const validation = core.validateSettlement(input, {
      transactions: transactions(), jointBills: state.jointBills || [], calendarBills: state.calendarBills || [],
      jointAdjustments: state.jointAdjustments || [], settlements: settlements(), creditEvents: creditEvents()
    });
    const errorHost = byId('household-settlement-errors');
    if (!validation.valid) {
      if (errorHost) {
        errorHost.innerHTML = '<strong>Please correct the following:</strong><ul class="list-disc pl-5 mt-1">' +
          validation.errors.map(error => '<li>' + esc(error) + '</li>').join('') + '</ul>';
        errorHost.classList.remove('hidden');
      }
      return;
    }
    if (typeof root.captureUndo === 'function') root.captureUndo('Reconcile household e-Transfer');
    const result = core.createSettlement(state, input);
    if (!result.saved) {
      if (errorHost) {
        errorHost.innerHTML = '<strong>Settlement was not saved:</strong><ul class="list-disc pl-5 mt-1">' +
          result.validation.errors.map(error => '<li>' + esc(error) + '</li>').join('') + '</ul>';
        errorHost.classList.remove('hidden');
      }
      return;
    }
    if (typeof root.saveData === 'function') root.saveData();
    closeHouseholdSettlementModal();
    renderHouseholdSettlementPanel();
    if (typeof root.renderJointAppView === 'function') root.renderJointAppView();
    if (typeof root.updateSidebarNetWorth === 'function') root.updateSidebarNetWorth();
    if (typeof root.renderAccountsPage === 'function') root.renderAccountsPage();
  }

  function settlementAvailableCredit(settlement) {
    const gross = core.summarizeSettlement(settlement, transactions()).creditCents;
    const used = creditEvents().filter(event => active(event) && String(event.settlementId) === String(settlement.id))
      .reduce((sum, event) => sum + Math.max(0, Number(event.amountCents) || 0), 0);
    return Math.max(0, gross - used);
  }

  function renderHouseholdSettlementPanel() {
    const host = byId('household-settlement-panel');
    if (!host || !core || !state) return;
    const ym = currentMonth();
    const monthBills = billsForMonth(ym);
    const monthPosition = core.settlementMonthPosition(ym, state.jointBills || [], settlements(), transactions(),
      state.jointAdjustments || [], creditEvents());
    const creditPosition = core.creditPositionCents(settlements(), transactions(), creditEvents());
    const activeMonthSettlements = settlements().filter(item => String(item.ym) === ym);
    const activeAllocations = activeMonthSettlements.filter(active).reduce((sum, item) =>
      sum + (item.allocations || []).reduce((n, allocation) => n + Math.max(0, Number(allocation.amountCents) || 0), 0), 0);
    const summary = byId('household-settlement-summary');
    if (summary) summary.innerHTML = [
      ['Existing withdrawals linked', money(monthPosition.transferCents)],
      ['Bill expenses allocated', money(activeAllocations)],
      ['Household share outstanding', money(monthPosition.outstandingCents)],
      ['Available household receivable', money(creditPosition.availableCreditCents)]
    ].map(([label, value]) => `<div class="rounded-xl border border-gray-200 dark:border-gray-800 p-3"><div class="text-[10px] uppercase tracking-wide text-gray-500">${esc(label)}</div><div class="font-bold text-lg accounting-num mt-1">${esc(value)}</div></div>`).join('');

    const history = byId('household-settlement-history');
    if (history) {
      history.innerHTML = activeMonthSettlements.length ? activeMonthSettlements.slice().sort((a,b) => String(b.date || '').localeCompare(String(a.date || ''))).map(item => {
        const bank = transactions().find(tx => String(tx.id) === String(item.bankTransactionId));
        const totals = core.summarizeSettlement(item, transactions());
        const lines = (item.allocations || []).map(allocation => {
          const bill = (state.jointBills || []).find(b => String(b.id) === String(allocation.jointBillId));
          const expense = transactions().find(tx => String(tx.id) === String(allocation.expenseTransactionId));
          return `<div class="flex justify-between gap-3 text-[11px] py-1"><span class="min-w-0 truncate">${esc(bill?.name || 'Deleted household bill')} · ${esc(expense?.vendor || expense?.desc || 'Linked expense')}</span><strong class="accounting-num whitespace-nowrap">${esc(money(allocation.amountCents))}</strong></div>`;
        }).join('');
        const status = active(item) ? '<span class="text-emerald-600 dark:text-emerald-400">Active</span>' : '<span class="text-gray-500">Reversed</span>';
        return `<article class="rounded-xl border border-gray-200 dark:border-gray-800 p-3 space-y-2">
          <div class="flex flex-wrap justify-between gap-2"><div class="min-w-0"><div class="font-semibold text-xs">${esc(item.date || 'Undated withdrawal')} · ${esc(bank?.vendor || bank?.desc || 'Missing linked withdrawal')}</div><div class="text-[10px] text-gray-500">${status} · Withdrawal ${esc(money(totals.bankAmountCents))}</div></div>
          ${active(item) ? '<button type="button" class="text-xs text-rose-600 underline" onclick="reverseHouseholdSettlement(\'' + esc(item.id) + '\')">Reverse link</button>' : ''}</div>
          <div class="divide-y divide-gray-100 dark:divide-gray-800">${lines}</div>
          <div class="flex justify-between text-xs border-t border-gray-200 dark:border-gray-800 pt-2"><span>Unallocated household credit</span><strong class="accounting-num">${esc(money(totals.creditCents))}</strong></div>
        </article>`;
      }).join('') : '<p class="text-xs text-gray-500">No existing withdrawals have been reconciled for this month.</p>';
    }

    const creditSummary = byId('household-settlement-credit-summary');
    if (creditSummary) creditSummary.innerHTML = `
      <div class="flex justify-between text-xs"><span class="text-gray-500">Gross overpayment credit</span><strong class="accounting-num">${esc(money(creditPosition.grossCreditCents))}</strong></div>
      <div class="flex justify-between text-xs"><span class="text-gray-500">Refunded or applied</span><strong class="accounting-num">${esc(money(creditPosition.appliedOrRefundedCents))}</strong></div>
      <div class="flex justify-between text-sm font-bold border-t border-gray-200 dark:border-gray-800 pt-2"><span>Receivable included in net worth</span><strong class="accounting-num text-emerald-600 dark:text-emerald-400">${esc(money(creditPosition.availableCreditCents))}</strong></div>`;

    const eventHost = byId('household-settlement-credit-events');
    if (eventHost) {
      eventHost.innerHTML = creditEvents().length ? creditEvents().slice().sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).map(event => {
        const tx = transactions().find(item => String(item.id) === String(event.transactionId));
        const settlement = settlements().find(item => String(item.id) === String(event.settlementId));
        return `<div class="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 dark:border-gray-800 py-2 text-xs">
          <div class="min-w-0"><strong>${event.type === 'refund' ? 'Partner refund' : 'Credit applied'}</strong><div class="text-[10px] text-gray-500">${esc(tx?.vendor || tx?.desc || 'Missing linked transaction')} · Source transfer ${esc(settlement?.date || 'Unknown date')} · ${active(event) ? 'Active' : 'Reversed'}</div></div>
          <div class="flex items-center gap-2"><strong class="accounting-num">${esc(money(event.amountCents))}</strong>${active(event) ? '<button type="button" class="text-rose-600 underline" onclick="reverseHouseholdCreditEvent(\'' + esc(event.id) + '\')">Reverse</button>' : ''}</div>
        </div>`;
      }).join('') : '<p class="text-xs text-gray-500">No partner refunds or credit applications recorded.</p>';
    }
  }

  function reverseHouseholdSettlement(id) {
    const settlement = settlements().find(item => String(item.id) === String(id));
    if (!settlement || !active(settlement)) return;
    if (!confirm('Reverse this settlement link? The existing bank withdrawal and bill expenses will remain unchanged. The linked allocations and any credit from this settlement will no longer count.')) return;
    const reason = prompt('Reason for reversing this settlement link (optional):') || '';
    if (typeof root.captureUndo === 'function') root.captureUndo('Reverse household settlement link');
    const result = core.reverseSettlement(state, id, reason);
    if (!result.reversed) { alert(result.error || 'The settlement could not be reversed.'); return; }
    root.saveData();
    renderHouseholdSettlementPanel();
    root.renderJointAppView();
    root.updateSidebarNetWorth();
    root.renderAccountsPage();
  }

  function openHouseholdCreditEventModal() {
    const activeSettlements = settlements().filter(item => active(item) && settlementAvailableCredit(item) > 0);
    if (!activeSettlements.length) {
      alert('There is no available household settlement credit to refund or apply.');
      return;
    }
    const source = byId('hhc-source-settlement');
    source.innerHTML = activeSettlements.map(item => {
      const bank = transactions().find(tx => String(tx.id) === String(item.bankTransactionId));
      return '<option value="' + esc(item.id) + '">' + esc((item.date || 'Undated') + ' · ' + (bank?.vendor || bank?.desc || 'E-Transfer') + ' · Available ' + money(settlementAvailableCredit(item))) + '</option>';
    }).join('');
    const type = byId('hhc-event-type');
    type.value = 'refund';
    type.onchange = updateHouseholdCreditEventFields;
    updateHouseholdCreditEventFields();
    byId('hhc-amount').value = '';
    byId('household-credit-event-errors')?.classList.add('hidden');
    byId('household-credit-event-modal')?.classList.remove('hidden');
  }

  function updateHouseholdCreditEventFields() {
    const type = byId('hhc-event-type')?.value || 'refund';
    const txSelect = byId('hhc-transaction');
    const candidates = transactions().filter(tx => String(tx.type || '').toLowerCase() === (type === 'refund' ? 'income' : 'expense') &&
      Number(tx.amount) > 0 && !tx.refundOfTransactionId && !tx.isReversal && !tx.reversalOfTransactionId && !tx.reconciledDuplicate);
    txSelect.innerHTML = '<option value="">Choose existing ' + (type === 'refund' ? 'income / deposit' : 'household expense') + '</option>' +
      candidates.sort((a,b) => String(b.date || '').localeCompare(String(a.date || ''))).map(tx => '<option value="' + esc(tx.id) + '">' + esc(transactionLabel(tx)) + '</option>').join('');
    const billWrap = byId('hhc-bill-wrap');
    if (billWrap) billWrap.classList.toggle('hidden', type !== 'application');
    if (type === 'application') {
      const ym = currentMonth();
      byId('hhc-bill').innerHTML = '<option value="">Choose household bill</option>' +
        billsForMonth(ym).map(bill => '<option value="' + esc(bill.id) + '">' + esc(bill.name) + '</option>').join('');
    }
  }

  function closeHouseholdCreditEventModal() {
    byId('household-credit-event-modal')?.classList.add('hidden');
  }

  function saveHouseholdCreditEvent() {
    const type = byId('hhc-event-type')?.value || 'refund';
    const input = {
      type,
      settlementId: String(byId('hhc-source-settlement')?.value || ''),
      transactionId: String(byId('hhc-transaction')?.value || ''),
      jointBillId: type === 'application' ? String(byId('hhc-bill')?.value || '') : '',
      amountCents: cents(byId('hhc-amount')?.value)
    };
    const result = core.validateCreditEvent(input, {
      settlements: settlements(), transactions: transactions(), jointBills: state.jointBills || [],
      calendarBills: state.calendarBills || [], jointAdjustments: state.jointAdjustments || [], creditEvents: creditEvents()
    });
    const errors = byId('household-credit-event-errors');
    if (!result.valid) {
      if (errors) {
        errors.innerHTML = '<strong>Please correct the following:</strong><ul class="list-disc pl-5 mt-1">' +
          result.errors.map(error => '<li>' + esc(error) + '</li>').join('') + '</ul>';
        errors.classList.remove('hidden');
      }
      return;
    }
    if (typeof root.captureUndo === 'function') root.captureUndo(type === 'refund' ? 'Record partner household refund' : 'Apply household settlement credit');
    const saved = core.createCreditEvent(state, input);
    if (!saved.saved) {
      if (errors) {
        errors.innerHTML = '<strong>Credit event was not saved:</strong><ul class="list-disc pl-5 mt-1">' +
          saved.validation.errors.map(error => '<li>' + esc(error) + '</li>').join('') + '</ul>';
        errors.classList.remove('hidden');
      }
      return;
    }
    root.saveData();
    closeHouseholdCreditEventModal();
    renderHouseholdSettlementPanel();
    root.renderJointAppView();
    root.updateSidebarNetWorth();
    root.renderAccountsPage();
  }

  function reverseHouseholdCreditEvent(id) {
    const event = creditEvents().find(item => String(item.id) === String(id));
    if (!event || !active(event)) return;
    if (!confirm('Reverse this credit event? The linked ledger transaction will remain unchanged; only the receivable / household settlement allocation will be restored.')) return;
    const reason = prompt('Reason for reversing this credit event (optional):') || '';
    if (typeof root.captureUndo === 'function') root.captureUndo('Reverse household credit event');
    const result = core.reverseCreditEvent(state, id, reason);
    if (!result.reversed) { alert(result.error || 'The credit event could not be reversed.'); return; }
    root.saveData();
    renderHouseholdSettlementPanel();
    root.renderJointAppView();
    root.updateSidebarNetWorth();
    root.renderAccountsPage();
  }

  root.openHouseholdSettlementModal = openHouseholdSettlementModal;
  root.closeHouseholdSettlementModal = closeHouseholdSettlementModal;
  root.saveHouseholdSettlement = saveHouseholdSettlement;
  root.renderHouseholdSettlementPanel = renderHouseholdSettlementPanel;
  root.reverseHouseholdSettlement = reverseHouseholdSettlement;
  root.openHouseholdCreditEventModal = openHouseholdCreditEventModal;
  root.closeHouseholdCreditEventModal = closeHouseholdCreditEventModal;
  root.updateHouseholdCreditEventFields = updateHouseholdCreditEventFields;
  root.saveHouseholdCreditEvent = saveHouseholdCreditEvent;
  root.reverseHouseholdCreditEvent = reverseHouseholdCreditEvent;
})(window);