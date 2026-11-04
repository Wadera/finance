import { CornerDownLeft, FolderPlus, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { BankAccountRecord, CurrencyCode } from '../shared/types.js';
import { type QuickAddTarget, apiFetch } from './api.js';
import type { TranslationDict } from './i18n.js';

type QuickChildKind = 'pot' | 'monthly_bill' | 'annual_goal' | 'expense';

export const QuickAddInline: React.FC<{
  target: QuickAddTarget;
  defaultCurrency: CurrencyCode;
  yearMonth: string;
  accounts?: BankAccountRecord[];
  t: TranslationDict;
  onCancel: () => void;
  onCreated: (result: { expandPotIds: string[] }) => Promise<void> | void;
}> = ({ target, defaultCurrency, yearMonth, accounts = [], t, onCancel, onCreated }) => {
  const [childKind, setChildKind] = useState<QuickChildKind>('pot');
  const [name, setName] = useState<string>('');
  const [amountMajor, setAmountMajor] = useState<string>('');
  const [currency, setCurrency] = useState<CurrencyCode>(target.currency || defaultCurrency);
  const [accountId, setAccountId] = useState<string>(() => {
    const wsAcc =
      accounts.find((a) => a.workspaceId === target.workspaceId && a.isPrimaryRunway) ||
      accounts.find((a) => a.workspaceId === target.workspaceId) ||
      accounts[0];
    return wsAcc?.id || '';
  });
  const [dueDate, setDueDate] = useState<string>(() => {
    const [y, m] = yearMonth.split('-').map(Number);
    return `${y + 1}-${String(m).padStart(2, '0')}-15`;
  });
  const [promoteAsEnvelope, setPromoteAsEnvelope] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setCurrency(target.currency || defaultCurrency);
    const wsAcc =
      accounts.find((a) => a.workspaceId === target.workspaceId && a.isPrimaryRunway) ||
      accounts.find((a) => a.workspaceId === target.workspaceId) ||
      accounts[0];
    if (wsAcc) setAccountId(wsAcc.id);
    setTimeout(() => inputRef.current?.focus(), 10);
  }, [target, defaultCurrency, accounts]);

  const isPromotion = target.targetKind !== 'pot';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName || submitting) return;

    const amountMinor = Math.max(0, Math.round(Number(amountMajor || 0) * 100));
    setSubmitting(true);
    try {
      if (target.targetKind === 'pot') {
        if (childKind === 'pot') {
          await apiFetch('/api/pots', {
            method: 'POST',
            body: JSON.stringify({
              workspaceId: target.workspaceId,
              parentId: target.potId,
              name: cleanName,
              color: target.color,
              envelopeMode: amountMinor > 0,
              monthlyEstimateMinor: amountMinor,
              currency,
            }),
          });
        } else if (childKind === 'monthly_bill' || childKind === 'annual_goal') {
          await apiFetch('/api/obligations', {
            method: 'POST',
            body: JSON.stringify({
              workspaceId: target.workspaceId,
              potId: target.potId,
              accountId: accountId || null,
              name: cleanName,
              amountMinor,
              currency,
              cadence: childKind === 'annual_goal' ? 'annual' : 'monthly',
              intervalMonths: childKind === 'annual_goal' ? 12 : 1,
              nextDueDate: childKind === 'annual_goal' ? dueDate : `${yearMonth}-15`,
              preservedMinor: 0,
              autoPreserve: true,
            }),
          });
        } else {
          const todayIso = new Date().toISOString().slice(0, 10);
          const spentDate = todayIso.slice(0, 7) === yearMonth ? todayIso : `${yearMonth}-04`;
          await apiFetch('/api/expenses', {
            method: 'POST',
            body: JSON.stringify({
              workspaceId: target.workspaceId,
              potId: target.potId,
              accountId: accountId || null,
              flowDirection: 'outflow',
              merchant: cleanName,
              description: '',
              amountMinor,
              currency,
              spentDate,
            }),
          });
        }
        await onCreated({ expandPotIds: [target.potId] });
      } else {
        // Promote existing obligation or expense into a Pot & create child inside it!
        const todayIso = new Date().toISOString().slice(0, 10);
        const spentDate = todayIso.slice(0, 7) === yearMonth ? todayIso : `${yearMonth}-04`;
        const res = await apiFetch<{ ok: boolean; newPotId: string; parentPotId: string | null }>(
          '/api/pots/promote-item',
          {
            method: 'POST',
            body: JSON.stringify({
              itemKind: target.targetKind,
              itemId: target.itemId,
              promoteMode: promoteAsEnvelope ? 'envelope' : 'group',
              child: {
                kind:
                  childKind === 'pot'
                    ? 'pot'
                    : childKind === 'expense'
                    ? 'expense'
                    : 'obligation',
                name: cleanName,
                amountMinor,
                currency,
                cadence: childKind === 'annual_goal' ? 'annual' : 'monthly',
                intervalMonths: childKind === 'annual_goal' ? 12 : 1,
                nextDueDate: childKind === 'annual_goal' ? dueDate : `${yearMonth}-15`,
                spentDate,
              },
            }),
          }
        );
        const expandIds = [res.newPotId];
        if (res.parentPotId) expandIds.push(res.parentPotId);
        await onCreated({ expandPotIds: expandIds });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
      onClick={(e) => e.stopPropagation()}
      className="bg-teal-50/65 border border-teal-200/90 rounded-lg p-3 space-y-2 text-xs shadow-2xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-medium text-teal-950">
          <FolderPlus className="w-3.5 h-3.5 text-teal-700 shrink-0" />
          <span>
            {target.targetKind === 'pot'
              ? t.quickAddInsidePot(target.potName)
              : t.quickPromoteItem(target.itemName)}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {(
            [
              ['pot', t.qaKindSubPot],
              ['monthly_bill', t.qaKindMonthlyBill],
              ['annual_goal', t.qaKindAnnualGoal],
              ['expense', t.qaKindExpense],
            ] as Array<[QuickChildKind, string]>
          ).map(([k, lbl]) => (
            <button
              key={k}
              type="button"
              onClick={() => setChildKind(k)}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition ${
                childKind === k
                  ? 'bg-teal-800 text-white'
                  : 'bg-white border border-teal-200 text-slate-600 hover:text-slate-900'
              }`}
            >
              {lbl}
            </button>
          ))}
          <button
            type="button"
            onClick={onCancel}
            className="p-0.5 text-slate-400 hover:text-slate-700 ml-1"
            title={t.qaCancel}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          required
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={
            childKind === 'pot'
              ? t.qaNamePlaceholderPot
              : childKind === 'expense'
              ? t.qaNamePlaceholderExp
              : t.qaNamePlaceholderBill
          }
          className="flex-1 min-w-[180px] bg-white border border-slate-300 rounded px-2.5 py-1.5 text-xs text-slate-900 focus:outline-none focus:border-teal-700"
        />

        <input
          type="number"
          step="0.01"
          min="0"
          required={childKind !== 'pot'}
          value={amountMajor}
          onChange={(e) => setAmountMajor(e.target.value)}
          placeholder={t.qaAmountPlaceholder}
          className="w-36 bg-white border border-slate-300 rounded px-2 py-1.5 text-xs font-mono-num text-slate-900 focus:outline-none focus:border-teal-700"
        />

        <select
          value={currency}
          onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
          className="bg-white border border-slate-300 rounded px-2 py-1.5 text-xs font-mono-num text-slate-800"
        >
          {(['GBP', 'EUR', 'PLN', 'USD', 'CHF'] as CurrencyCode[]).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        {childKind !== 'pot' && accounts.length > 0 && (
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="bg-white border border-slate-300 rounded px-2 py-1.5 text-xs text-slate-800 max-w-[180px]"
            title={t.bankAccountLabel}
          >
            <option value="">{t.noAccountLinkOption}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                🏦 {a.name} ({a.currency})
              </option>
            ))}
          </select>
        )}

        {childKind === 'annual_goal' && (
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="bg-white border border-slate-300 rounded px-2 py-1.5 text-xs font-mono-num text-slate-800"
          />
        )}

        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 transition"
        >
          <span>{t.qaSave}</span>
          <CornerDownLeft className="w-3 h-3 text-teal-400" />
        </button>
      </div>

      {isPromotion && (
        <label className="flex items-center gap-1.5 text-[11px] text-teal-900 pt-0.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={promoteAsEnvelope}
            onChange={(e) => setPromoteAsEnvelope(e.target.checked)}
            className="rounded border-teal-400"
          />
          <span>{t.qaEnvelopeToggle}</span>
        </label>
      )}
    </form>
  );
};
