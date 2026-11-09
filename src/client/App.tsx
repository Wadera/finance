import {
  AlertTriangle,
  ArrowLeftRight,
  Building2,
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  FolderTree,
  Globe,
  KeyRound,
  Landmark,
  Lock,
  LogOut,
  Paperclip,
  Pencil,
  PiggyBank,
  Plus,
  RefreshCw,
  RotateCcw,
  Shield,
  Sparkles,
  Trash2,
  TrendingDown,
  TrendingUp,
  Upload,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CURRENCY_SYMBOLS, formatDisplayValue, formatIndexedWealth } from '../shared/currency.js';
import { buildPotBreadcrumbs, collectSubtreePotIds } from '../shared/financeEngine.js';
import type {
  AttachmentRecord,
  CurrencyCode,
  LocaleCode,
  PartnerVisibility,
  PotRollupNode,
  SplitMode,
  TransactionStatus,
  WorkspaceKind,
  WorkspaceRole,
} from '../shared/types.js';
import {
  type AuthStatusResponse,
  type BootstrapResponse,
  type BudgetMonthResponse,
  type EnrichedExpense,
  type EnrichedIncome,
  type EnrichedObligation,
  type QuickAddTarget,
  type WealthOverviewResponse,
  apiFetch,
  createTransferApi,
  createTransferBatchApi,
  deleteTransferApi,
  listAttachmentsApi,
} from './api.js';
import {
  CashflowSankeyChart,
  DailyRunwayChart,
  HorizonHistoryChart,
  PotProportionStrip,
  SixMonthTrendChart,
  WealthHorizonChart,
} from './charts.js';
import { I18N } from './i18n.js';
import { QuickAddInline } from './QuickAddInline.js';

type TabKey = 'overview' | 'timeline' | 'pots' | 'wealth' | 'settings';

type ModalKind =
  | null
  | { kind: 'obligation'; defaultPotId?: string | null }
  | { kind: 'expense'; defaultPotId?: string | null }
  | { kind: 'pot'; defaultParentId?: string | null }
  | { kind: 'income' }
  | { kind: 'account' }
  | {
      kind: 'transfer';
      mode?: 'single' | 'distribute';
      defaultSourceAccountId?: string | null;
      defaultDestAccountId?: string | null;
      defaultAmountMajor?: number;
    }
  | { kind: 'asset' }
  | { kind: 'liability' }
  | { kind: 'workspace' };

interface DrawerSubject {
  entityType: 'obligation' | 'expense' | 'asset' | 'liability' | 'pot' | 'income' | 'account';
  entityId: string;
  workspaceId: string;
  title: string;
  subtitle: string;
  manageUrl?: string | null;
  portalUrl?: string | null;
  referenceNumber?: string | null;
  notes?: string | null;
  items?: Array<{ id: string; name: string; subCategory: string | null; amountMinor: number }>;
  currency: CurrencyCode;
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12 + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

function buildAgentBootstrapPrompt(params: {
  origin: string;
  displayName: string;
  personalWorkspaceId: string;
  defaultCurrency: CurrencyCode;
  token: string;
}): string {
  const mcpUrl = `${params.origin}/api/mcp`;
  const attachUrl = `${params.origin}/api/attachments`;
  return `Connect to my **Skyday Finance & Budget** MCP server so you can read my nested spending pots, check monthly budgets, categorize receipt photos/invoices, and tick scheduled bills as paid.

### 1. Connection & Credentials
- **MCP Endpoint (Streamable HTTP / JSON-RPC 2.0 \`POST\`):** \`${mcpUrl}\`
- **Attachment Upload Endpoint (Multipart \`POST\`):** \`${attachUrl}\`
- **Authorization Header:** \`Authorization: Bearer ${params.token}\`
- **Authenticated Account:** ${params.displayName} (Default currency: \`${params.defaultCurrency}\`)
- **Primary Workspaces:** \`ws-home\` (Shared Household) and \`${params.personalWorkspaceId}\` (${params.displayName} Personal)

> Security rule: Store this Bearer token in your secret file or local \`mcp_config.json\` (mode 0600); never commit it to Git or echo it into public reports.

### 2. Register in \`mcp_config.json\`
\`\`\`json
{
  "mcpServers": {
    "skyday-finance": {
      "url": "${mcpUrl}",
      "headers": {
        "Authorization": "Bearer ${params.token}"
      }
    }
  }
}
\`\`\`

### 3. Available MCP Tools
1. **\`list_accounts\` / \`get_account\` / \`set_account_balance_snapshot\`:** Inspect accounts, booked vs available balances, funded reserves, and record non-destructive balance snapshots.
2. **\`list_transactions\` / \`get_transaction\` / \`upsert_transaction\` / \`delete_transaction\`:** Query ledger, import/correct transactions with \`pending\` / \`posted\` / \`reversed\` / \`refunded\` status, idempotency keys, and delta-only balance updates.
3. **\`create_transfer\` / \`update_transfer\` / \`delete_transfer\` / \`list_transfers\`:** Atomic inter-account money movements and salary distributions with linked debit & credit legs.
4. **\`list_upcoming_obligations\` / \`mark_obligation_paid\` / \`update_obligation_schedule\`:** Record obligation payments with bank dates & idempotency keys, or adjust future/final installments.
5. **\`get_monthly_budget\` / \`reconcile_batch\` / \`reverse_reconciliation_batch\`:** Full budget, account sufficiency, funded vs planned reserves, and dry-run/atomic reconciliation batches.
6. **\`list_pots\` / \`create_pot\` / \`log_expense_receipt\` / \`attach_receipt_base64\`:** Manage nested pots and attach receipt evidence.`;
}

export const App: React.FC = () => {
  const [auth, setAuth] = useState<AuthStatusResponse | null>(null);
  const [boot, setBoot] = useState<BootstrapResponse | null>(null);
  const [budget, setBudget] = useState<BudgetMonthResponse | null>(null);
  const [wealth, setWealth] = useState<WealthOverviewResponse | null>(null);

  const [tab, setTab] = useState<TabKey>('overview');
  const [yearMonth, setYearMonth] = useState<string>(() => new Date().toISOString().slice(0, 7));
  const [budgetHorizon, setBudgetHorizon] = useState<1 | 3 | 6 | 12 | 60 | 120>(1);
  const [scope, setScope] = useState<string>('all');
  const [wealthPastYears, setWealthPastYears] = useState<number>(5);
  const [horizonYears, setHorizonYears] = useState<number>(5);
  const [wealthMode, setWealthMode] = useState<'combined' | 'mine'>('combined');
  const [selectedPotId, setSelectedPotId] = useState<string | null>(null);

  const [locale, setLocale] = useState<LocaleCode>(() => {
    const saved = localStorage.getItem('skyday_locale');
    return saved === 'pl' ? 'pl' : 'en';
  });
  const t = I18N[locale];

  // Unlimited-depth unfold state for Overview Sankey & Pots Tree
  const [sankeyExpandedPots, setSankeyExpandedPots] = useState<Set<string>>(() => new Set());
  const [sankeyExpandedExps, setSankeyExpandedExps] = useState<Set<string>>(() => new Set());
  const [collapsedTreePots, setCollapsedTreePots] = useState<Set<string>>(() => new Set());

  // Inline Quick-Add & Item-to-Pot Promotion target
  const [quickAddTarget, setQuickAddTarget] = useState<QuickAddTarget | null>(null);

  // Local Login state on Login Gate
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginErr, setLoginErr] = useState<string | null>(null);

  const [privacyMode, setPrivacyMode] = useState<boolean>(() => {
    return localStorage.getItem('skyday_privacy_mode') === '1';
  });

  const [modal, setModal] = useState<ModalKind>(null);
  const [transferMode, setTransferMode] = useState<'single' | 'distribute'>('single');
  const [transferSourceId, setTransferSourceId] = useState<string>('');
  const [transferDestId, setTransferDestId] = useState<string>('');
  const [transferAmountMajor, setTransferAmountMajor] = useState<string>('');
  const [transferBatchMap, setTransferBatchMap] = useState<Record<string, string>>({});
  const [transferDate, setTransferDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [transferTime, setTransferTime] = useState<string>(() => new Date().toISOString().slice(11, 16) || '12:00');
  const [transferDesc, setTransferDesc] = useState<string>('');
  const [transferRef, setTransferRef] = useState<string>('');
  const [drawer, setDrawer] = useState<DrawerSubject | null>(null);
  const [drawerAttachments, setDrawerAttachments] = useState<AttachmentRecord[]>([]);
  const [drawerSavedMsg, setDrawerSavedMsg] = useState<string | null>(null);
  const [ledgerOpen, setLedgerOpen] = useState<boolean>(false);
  const [timelineAccountId, setTimelineAccountId] = useState<string>('all');
  const [accountsFolded, setAccountsFolded] = useState<boolean>(true);
  const [advisoryOpen, setAdvisoryOpen] = useState<boolean>(true);
  const [preserveExpandedIds, setPreserveExpandedIds] = useState<Set<string>>(() => new Set());
  const [sankeyShowLayers, setSankeyShowLayers] = useState<boolean>(true);
  const [checklistPaidFolded, setChecklistPaidFolded] = useState<boolean>(true);
  const [highlightedObId, setHighlightedObId] = useState<string | null>(null);
  const [horizonMenuOpen, setHorizonMenuOpen] = useState<boolean>(false);
  const [calendarOpen, setCalendarOpen] = useState<boolean>(false);
  const [calendarYear, setCalendarYear] = useState<number>(() => Number(new Date().toISOString().slice(0, 4)) || 2026);

  const scrollToChecklistObligation = useCallback((obId: string | null) => {
    const targetEl =
      (obId ? document.getElementById(`checklist-ob-${obId}`) : null) ||
      document.getElementById('checklist-shortfall-anchor') ||
      document.getElementById('checklist-section');
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (obId) {
      setHighlightedObId(obId);
      setTimeout(() => {
        setHighlightedObId((prev) => (prev === obId ? null : prev));
      }, 3800);
    }
  }, []);
  const [quickMenuOpen, setQuickMenuOpen] = useState<boolean>(false);
  const [newlyMintedKey, setNewlyMintedKey] = useState<string | null>(null);
  const [agentKeyLabel, setAgentKeyLabel] = useState<string>('');
  const [copiedNotice, setCopiedNotice] = useState<string | null>(null);
  const [inviteBanner, setInviteBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const togglePrivacy = useCallback(() => {
    setPrivacyMode((prev) => {
      const next = !prev;
      localStorage.setItem('skyday_privacy_mode', next ? '1' : '0');
      return next;
    });
  }, []);

  const switchLocale = useCallback(
    async (next: LocaleCode) => {
      setLocale(next);
      localStorage.setItem('skyday_locale', next);
      if (auth?.authenticated) {
        await apiFetch('/api/settings/preferences', {
          method: 'PATCH',
          body: JSON.stringify({ locale: next }),
        }).catch(() => {});
      }
    },
    [auth?.authenticated]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        togglePrivacy();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePrivacy]);

  const reloadAll = useCallback(async () => {
    try {
      setErrorMsg(null);
      const st = await apiFetch<AuthStatusResponse>('/api/auth/status');
      setAuth(st);
      if (st.user?.locale && !localStorage.getItem('skyday_locale')) {
        setLocale(st.user.locale);
      }
      if (!st.authenticated) return;

      const accQuery =
        timelineAccountId && timelineAccountId !== 'all' ? `&accountId=${encodeURIComponent(timelineAccountId)}` : '';
      const [b, m, w] = await Promise.all([
        apiFetch<BootstrapResponse>('/api/bootstrap'),
        apiFetch<BudgetMonthResponse>(
          `/api/budget/month?ym=${encodeURIComponent(yearMonth)}&scope=${encodeURIComponent(scope)}&horizon=${budgetHorizon}${accQuery}`
        ),
        apiFetch<WealthOverviewResponse>(
          `/api/wealth/overview?horizon=${horizonYears}&past=${wealthPastYears}&scope=${encodeURIComponent(scope)}`
        ),
      ]);
      setBoot(b);
      setBudget(m);
      setWealth(w);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load data');
    }
  }, [yearMonth, scope, horizonYears, wealthPastYears, budgetHorizon, timelineAccountId]);

  useEffect(() => {
    void reloadAll();
  }, [reloadAll]);

  useEffect(() => {
    if (!drawer) {
      setDrawerAttachments([]);
      return;
    }
    void listAttachmentsApi(drawer.entityType, drawer.entityId)
      .then(setDrawerAttachments)
      .catch(() => setDrawerAttachments([]));
  }, [drawer]);

  const cur: CurrencyCode = boot?.user.defaultCurrency ?? 'GBP';
  const refIncome = budget?.kpis.totalIncomeMinor || budget?.kpis.potPlannedTotalMinor || 1;

  const fmt = useCallback(
    (minor: number, refOverride?: number, compact = false) =>
      formatDisplayValue(minor, {
        currency: cur,
        privacyMode,
        referenceTotalMinor: refOverride ?? refIncome,
        compact,
      }),
    [cur, privacyMode, refIncome]
  );

  const potBreadcrumbs = useMemo(() => (budget ? buildPotBreadcrumbs(budget.pots) : new Map()), [budget]);

  // Subtree pot IDs for selectedPotId so clicking a parent pot shows all nested receipts & bills across unlimited depth
  const activeSubtreePotIds = useMemo(() => {
    if (!budget || !selectedPotId) return null;
    return collectSubtreePotIds(selectedPotId, budget.pots);
  }, [budget, selectedPotId]);

  const visiblePotTreeRows = useMemo(() => {
    if (!budget) return [];
    const sourceObs = budget.allObligations ?? budget.obligations;
    const sourceExps = budget.allExpenses ?? budget.expenses;
    const obsByPot = new Map<string, EnrichedObligation[]>();
    for (const ob of sourceObs) {
      if (!ob.potId) continue;
      if (ob.effectiveDisplayMinor <= 0 && !ob.isPaidThisMonth && ob.preservedDisplayMinor <= 0) continue;
      const list = obsByPot.get(ob.potId) ?? [];
      list.push(ob);
      obsByPot.set(ob.potId, list);
    }
    const expsByPot = new Map<string, EnrichedExpense[]>();
    for (const exp of sourceExps) {
      if (!exp.potId) continue;
      if (exp.flowDirection === 'inflow' || (exp.kind ?? 'expense') === 'transfer') continue;
      if ((exp.status ?? 'posted') === 'reversed' || (exp.status ?? 'posted') === 'refunded') continue;
      const list = expsByPot.get(exp.potId) ?? [];
      list.push(exp);
      expsByPot.set(exp.potId, list);
    }

    const sumPotSubtreeStatus = (
      n: PotRollupNode
    ): { spentPaidMinor: number; plannedUpcomingMinor: number } => {
      let spentPaidMinor = 0;
      let plannedUpcomingMinor = n.unallocatedEnvelopeDisplayMinor;
      for (const exp of expsByPot.get(n.pot.id) ?? []) {
        if ((exp.status ?? 'posted') === 'pending') plannedUpcomingMinor += exp.displayAmountMinor;
        else spentPaidMinor += exp.displayAmountMinor;
      }
      for (const ob of obsByPot.get(n.pot.id) ?? []) {
        if (ob.isPaidThisMonth) spentPaidMinor += ob.effectiveDisplayMinor;
        else plannedUpcomingMinor += ob.effectiveDisplayMinor;
      }
      for (const ch of n.children) {
        const sub = sumPotSubtreeStatus(ch);
        spentPaidMinor += sub.spentPaidMinor;
        plannedUpcomingMinor += sub.plannedUpcomingMinor;
      }
      return { spentPaidMinor, plannedUpcomingMinor };
    };

    const out: Array<{
      node: PotRollupNode;
      depth: number;
      directObs: EnrichedObligation[];
      directExps: EnrichedExpense[];
      hasChildren: boolean;
      isCollapsed: boolean;
      spentPaidMinor: number;
      plannedUpcomingMinor: number;
    }> = [];

    const walk = (nodes: PotRollupNode[], depth: number) => {
      for (const n of nodes) {
        const directObs = obsByPot.get(n.pot.id) ?? [];
        const directExps = expsByPot.get(n.pot.id) ?? [];
        const hasChildren = n.children.length > 0 || directObs.length > 0 || directExps.length > 0;
        const isCollapsed = collapsedTreePots.has(n.pot.id);
        const { spentPaidMinor, plannedUpcomingMinor } = sumPotSubtreeStatus(n);
        out.push({
          node: n,
          depth,
          directObs,
          directExps,
          hasChildren,
          isCollapsed,
          spentPaidMinor,
          plannedUpcomingMinor,
        });
        if (!isCollapsed) {
          walk(n.children, depth + 1);
        }
      }
    };
    walk(budget.potTree, 0);
    return out;
  }, [budget, collapsedTreePots]);

  const handleToggleSankeyPot = useCallback((potId: string) => {
    setSankeyExpandedPots((prev) => {
      const next = new Set(prev);
      if (next.has(potId)) next.delete(potId);
      else next.add(potId);
      return next;
    });
  }, []);

  const handleToggleSankeyExpense = useCallback((expId: string) => {
    setSankeyExpandedExps((prev) => {
      const next = new Set(prev);
      if (next.has(expId)) next.delete(expId);
      else next.add(expId);
      return next;
    });
  }, []);

  const toggleTreePotCollapse = useCallback((potId: string) => {
    setCollapsedTreePots((prev) => {
      const next = new Set(prev);
      if (next.has(potId)) next.delete(potId);
      else next.add(potId);
      return next;
    });
  }, []);

  // --- Unauthenticated SSO + Local Account Gate ---
  if (auth && !auth.authenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-[#FAF9F6]">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-xl p-8 shadow-xs space-y-6">
          <div className="flex items-center justify-between">
            <div className="text-xs font-mono-num uppercase tracking-widest text-teal-700 font-semibold">
              {t.loginBadge}
            </div>
            <div className="inline-flex border border-slate-200 rounded-md p-0.5 text-[11px] font-mono-num">
              {(['en', 'pl'] as LocaleCode[]).map((lc) => (
                <button
                  key={lc}
                  type="button"
                  onClick={() => void switchLocale(lc)}
                  className={`px-2 py-0.5 rounded uppercase ${
                    locale === lc ? 'bg-slate-900 text-white' : 'text-slate-500'
                  }`}
                >
                  {lc}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <h1 className="text-2xl font-semibold text-slate-900">{t.loginTitle}</h1>
            <p className="text-sm text-slate-500">{t.loginSubtitle}</p>
          </div>

          {auth.oidcConfigured && (
            <a
              href={auth.loginUrl}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 transition"
            >
              <Shield className="w-4 h-4 text-teal-400" />
              {t.signInAuthentik}
            </a>
          )}

          <div className="relative flex py-1 items-center">
            <div className="flex-grow border-t border-slate-200" />
            <span className="flex-shrink mx-3 text-[11px] text-slate-400 font-mono-num">{t.orLocalLogin}</span>
            <div className="flex-grow border-t border-slate-200" />
          </div>

          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setLoginErr(null);
              try {
                await apiFetch('/api/auth/local/login', {
                  method: 'POST',
                  body: JSON.stringify({ username: loginUsername, password: loginPassword }),
                });
                setLoginPassword('');
                await reloadAll();
              } catch (err) {
                setLoginErr(err instanceof Error ? err.message : 'Login failed');
              }
            }}
          >
            {loginErr && (
              <div className="p-2.5 rounded bg-rose-50 border border-rose-200 text-rose-700 text-xs">{loginErr}</div>
            )}
            <input
              type="text"
              required
              value={loginUsername}
              onChange={(e) => setLoginUsername(e.target.value)}
              placeholder={t.usernameOrEmail}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-teal-700"
            />
            <input
              type="password"
              required
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              placeholder={t.password}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-teal-700"
            />
            <button
              type="submit"
              className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 text-xs font-medium hover:bg-slate-50 transition"
            >
              <Lock className="w-3.5 h-3.5 text-teal-700" />
              {t.signInLocal}
            </button>
          </form>

          <div className="text-[11px] text-slate-400 font-mono-num text-center">{t.loginFooter}</div>
        </div>
      </div>
    );
  }

  if (!boot || !budget || !wealth) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-slate-500 font-mono-num">
        {t.loading}
      </div>
    );
  }

  const writableWorkspaces = boot.workspaces.filter((w) => w.canWrite);
  const readableWorkspaces = boot.workspaces.filter((w) => w.canReadItems);
  const myPersonalWs = boot.workspaces.find((w) => w.id === boot.user.personalWorkspaceId);
  const sharedWs = boot.workspaces.find((w) => w.id === 'ws-home');
  const defaultActiveWsId =
    writableWorkspaces.find((w) => w.id === scope)?.id ||
    writableWorkspaces.find((w) => w.id === 'ws-home')?.id ||
    boot.user.personalWorkspaceId;

  const handleTogglePaid = async (ob: EnrichedObligation) => {
    setBusy(true);
    try {
      await apiFetch(`/api/obligations/${ob.id}/toggle-paid`, {
        method: 'POST',
        body: JSON.stringify({ yearMonth, paid: !ob.isPaidThisMonth }),
      });
      await reloadAll();
    } finally {
      setBusy(false);
    }
  };

  const handleToggleIncomeReceived = async (inc: EnrichedIncome) => {
    setBusy(true);
    try {
      await apiFetch(`/api/incomes/${inc.id}/toggle-received`, {
        method: 'POST',
        body: JSON.stringify({ yearMonth, received: !inc.isReceivedThisMonth }),
      });
      await reloadAll();
    } finally {
      setBusy(false);
    }
  };

  const allAvailableAccounts = budget.allAccounts && budget.allAccounts.length > 0 ? budget.allAccounts : budget.accounts;
  const allAvailableLiabilities =
    budget.allLiabilities && budget.allLiabilities.length > 0 ? budget.allLiabilities : wealth.liabilities;
  const defaultAccountForWs = (wsId: string) =>
    allAvailableAccounts.find((a) => a.workspaceId === wsId && a.isPrimaryRunway)?.id ||
    allAvailableAccounts.find((a) => a.workspaceId === wsId)?.id ||
    allAvailableAccounts[0]?.id ||
    '';

  const openTransferModal = (opts?: {
    mode?: 'single' | 'distribute';
    defaultSourceAccountId?: string | null;
    defaultDestAccountId?: string | null;
    defaultAmountMajor?: number;
    defaultDescription?: string;
  }) => {
    const salaryAccId =
      opts?.defaultSourceAccountId ||
      budget.allIncomes.find((i) => i.isActive && i.accountId)?.accountId ||
      allAvailableAccounts.find((a) => a.name.toLowerCase().includes('salary') || a.name.toLowerCase().includes('classic'))?.id ||
      allAvailableAccounts[0]?.id ||
      '';
    const destAccId =
      opts?.defaultDestAccountId ||
      allAvailableAccounts.find((a) => a.id !== salaryAccId)?.id ||
      '';
    setTransferMode(opts?.mode || 'single');
    setTransferSourceId(salaryAccId);
    setTransferDestId(destAccId);
    setTransferAmountMajor(
      opts?.defaultAmountMajor && opts.defaultAmountMajor > 0 ? opts.defaultAmountMajor.toFixed(2) : ''
    );
    setTransferBatchMap({});
    setTransferDate(new Date().toISOString().slice(0, 10));
    setTransferTime(new Date().toISOString().slice(11, 16) || '12:00');
    setTransferDesc(opts?.defaultDescription || '');
    setTransferRef('');
    setModal({
      kind: 'transfer',
      mode: opts?.mode || 'single',
      defaultSourceAccountId: salaryAccId,
      defaultDestAccountId: destAccId,
      defaultAmountMajor: opts?.defaultAmountMajor,
    });
  };

  const openEntityDrawer = (
    entityType: DrawerSubject['entityType'],
    entityId: string
  ) => {
    setDrawerSavedMsg(null);
    if (entityType === 'obligation') {
      const ob = (budget.allObligations ?? budget.obligations).find((o) => o.id === entityId);
      if (ob) {
        setDrawer({
          entityType: 'obligation',
          entityId: ob.id,
          workspaceId: ob.workspaceId,
          title: ob.name,
          subtitle: `${ob.cadence} · ${t.dueLabel} ${ob.nextDueDate}`,
          manageUrl: ob.manageUrl,
          portalUrl: ob.portalUrl,
          referenceNumber: ob.referenceNumber,
          notes: ob.notes,
          currency: ob.currency,
        });
      }
    } else if (entityType === 'expense') {
      const exp = (budget.allExpenses ?? budget.expenses).find((e) => e.id === entityId);
      if (exp) {
        setDrawer({
          entityType: 'expense',
          entityId: exp.id,
          workspaceId: exp.workspaceId,
          title: exp.merchant,
          subtitle: `${exp.spentDate}${exp.description ? ` · ${exp.description}` : ''}`,
          portalUrl: exp.portalUrl,
          items: exp.items,
          currency: exp.currency,
        });
      }
    } else if (entityType === 'pot') {
      const pot = budget.pots.find((p) => p.id === entityId);
      if (pot) {
        setDrawer({
          entityType: 'pot',
          entityId: pot.id,
          workspaceId: pot.workspaceId,
          title: pot.name,
          subtitle: potBreadcrumbs.get(pot.id)?.pathString || pot.name,
          currency: pot.currency,
        });
      }
    } else if (entityType === 'income') {
      const inc =
        budget.allIncomes.find((i) => i.id === entityId) ||
        wealth.salaryHistory.find((i) => i.id === entityId);
      if (inc) {
        setDrawer({
          entityType: 'income',
          entityId: inc.id,
          workspaceId: inc.workspaceId,
          title: inc.name,
          subtitle: `${inc.cadence} · Payday ${inc.paydayDay}.`,
          portalUrl: inc.portalUrl,
          notes: inc.notes,
          currency: inc.currency,
        });
      }
    } else if (entityType === 'account') {
      const acc = allAvailableAccounts.find((a) => a.id === entityId);
      if (acc) {
        setDrawer({
          entityType: 'account',
          entityId: acc.id,
          workspaceId: acc.workspaceId,
          title: acc.name,
          subtitle: acc.institution || 'Bank Account',
          portalUrl: acc.portalUrl,
          notes: acc.notes,
          currency: acc.currency,
        });
      }
    } else if (entityType === 'asset') {
      const ast = wealth.assets.find((a) => a.id === entityId);
      if (ast) {
        setDrawer({
          entityType: 'asset',
          entityId: ast.id,
          workspaceId: ast.workspaceId,
          title: ast.name,
          subtitle: `${ast.assetClass} · ${(ast.annualRateBp / 100).toFixed(1)}%/yr`,
          manageUrl: ast.manageUrl,
          portalUrl: ast.portalUrl,
          referenceNumber: ast.referenceNumber,
          notes: ast.notes,
          currency: ast.currency,
        });
      }
    } else if (entityType === 'liability') {
      const lb =
        allAvailableLiabilities.find((l) => l.id === entityId) ||
        wealth.liabilities.find((l) => l.id === entityId);
      if (lb) {
        setDrawer({
          entityType: 'liability',
          entityId: lb.id,
          workspaceId: lb.workspaceId,
          title: lb.name,
          subtitle: `${lb.kind} · ${(lb.aprBp / 100).toFixed(2)}% APR`,
          portalUrl: lb.portalUrl,
          referenceNumber: lb.referenceNumber,
          notes: lb.notes,
          currency: lb.currency,
        });
      }
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#FAF9F6] text-slate-800">
      {/* Editorial Top Bar — Zero Horizontal Scroll, Foldable Period & Quick-Settings Menus */}
      <header className="sticky top-0 z-20 bg-[#FAF9F6]/95 backdrop-blur border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-3 sm:px-6 h-14 flex items-center justify-between gap-2">
          {/* Left: Brand + Desktop Navigation */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-2 whitespace-nowrap shrink-0">
              <span className="w-2.5 h-2.5 rounded-xs bg-teal-700 shrink-0" />
              <span className="font-mono-num text-xs sm:text-sm font-semibold tracking-tight text-slate-900 whitespace-nowrap">
                {t.loginBadge}
              </span>
            </div>

            <nav className="hidden md:flex items-center gap-0.5 shrink-0">
              {(
                [
                  ['overview', t.tabOverview],
                  ['timeline', t.tabTimeline],
                  ['pots', t.tabPots],
                  ['wealth', t.tabWealth],
                  ['settings', t.tabSettings],
                ] as Array<[TabKey, string]>
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setTab(k)}
                  className={`px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition ${
                    tab === k
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>
          </div>

          {/* Right: Month + Foldable Period Badge + Icon Controls + Foldable Workspace/Settings Menu */}
          <div className="flex items-center gap-1.5 shrink-0">
            {tab !== 'wealth' && tab !== 'settings' && (
              <div className="relative inline-flex items-center border border-slate-200 bg-white rounded-md text-xs font-mono-num whitespace-nowrap shrink-0 divide-x divide-slate-200">
                <div className="inline-flex items-center">
                  <button
                    type="button"
                    onClick={() => setYearMonth((ym) => shiftMonth(ym, -1))}
                    className="p-1.5 text-slate-500 hover:text-slate-900"
                    title={t.prevMonth}
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const curY = Number(yearMonth.slice(0, 4)) || new Date().getFullYear();
                      setCalendarYear(curY);
                      setCalendarOpen((prev) => !prev);
                      setHorizonMenuOpen(false);
                      setQuickMenuOpen(false);
                    }}
                    className={`inline-flex items-center gap-1 px-1.5 py-1 rounded font-medium whitespace-nowrap transition ${
                      calendarOpen
                        ? 'bg-teal-50 text-teal-900 ring-1 ring-teal-600/30'
                        : 'text-slate-800 hover:bg-slate-100'
                    }`}
                    title={locale === 'pl' ? 'Kliknij, aby wybrać miesiąc i rok' : 'Click to pick month & year'}
                  >
                    <Calendar className="w-3 h-3 text-teal-700 shrink-0" />
                    <span>{yearMonth}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setYearMonth((ym) => shiftMonth(ym, 1))}
                    className="p-1.5 text-slate-500 hover:text-slate-900"
                    title={t.nextMonth}
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Month & Year Quick Calendar Popover */}
                {calendarOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-20"
                      onClick={() => setCalendarOpen(false)}
                    />
                    <div className="absolute left-0 sm:left-auto sm:right-0 top-full mt-1.5 z-30 w-64 bg-white border border-slate-200 rounded-xl shadow-xl p-3 space-y-2.5 text-xs">
                      {/* Year Selector Bar */}
                      <div className="flex items-center justify-between gap-1 pb-1.5 border-b border-slate-100">
                        <button
                          type="button"
                          onClick={() => setCalendarYear((y) => y - 1)}
                          className="p-1 rounded border border-slate-200 text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition"
                          title={locale === 'pl' ? 'Poprzedni rok' : 'Previous year'}
                        >
                          <ChevronLeft className="w-3.5 h-3.5" />
                        </button>
                        <div className="font-mono-num text-sm font-bold text-slate-900">
                          {calendarYear}
                        </div>
                        <button
                          type="button"
                          onClick={() => setCalendarYear((y) => y + 1)}
                          className="p-1 rounded border border-slate-200 text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition"
                          title={locale === 'pl' ? 'Następny rok' : 'Next year'}
                        >
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* Quick Year Pills */}
                      <div className="grid grid-cols-5 gap-1">
                        {[-2, -1, 0, 1, 2].map((offset) => {
                          const yVal = calendarYear + offset;
                          const isSelectedY = yVal === calendarYear;
                          return (
                            <button
                              key={yVal}
                              type="button"
                              onClick={() => setCalendarYear(yVal)}
                              className={`py-1 rounded text-[10.5px] font-mono-num transition ${
                                isSelectedY
                                  ? 'bg-slate-900 text-white font-semibold'
                                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                              }`}
                            >
                              {yVal}
                            </button>
                          );
                        })}
                      </div>

                      {/* 12-Month Grid (Jan - Dec) */}
                      <div className="grid grid-cols-3 gap-1.5 pt-0.5">
                        {(locale === 'pl'
                          ? ['Sty', 'Lut', 'Mar', 'Kwi', 'Maj', 'Cze', 'Lip', 'Sie', 'Wrz', 'Paź', 'Lis', 'Gru']
                          : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
                        ).map((mLabel, idx) => {
                          const mm = String(idx + 1).padStart(2, '0');
                          const candidateYm = `${calendarYear}-${mm}`;
                          const isSelectedYm = candidateYm === yearMonth;
                          const todayYm = new Date().toISOString().slice(0, 7);
                          const isTodayYm = candidateYm === todayYm;
                          return (
                            <button
                              key={mm}
                              type="button"
                              onClick={() => {
                                setYearMonth(candidateYm);
                                setCalendarOpen(false);
                              }}
                              className={`relative py-2 px-2 rounded-md font-mono-num text-xs transition flex flex-col items-center justify-center ${
                                isSelectedYm
                                  ? 'bg-teal-700 text-white font-semibold shadow-xs'
                                  : isTodayYm
                                  ? 'bg-teal-50/80 text-teal-900 border border-teal-400 font-semibold hover:bg-teal-100'
                                  : 'bg-[#FAF9F6] text-slate-700 border border-slate-200/70 hover:bg-slate-100 hover:border-slate-300'
                              }`}
                            >
                              <span>{mLabel}</span>
                              <span
                                className={`text-[9px] ${
                                  isSelectedYm ? 'text-teal-100' : 'text-slate-400'
                                }`}
                              >
                                {mm}
                              </span>
                            </button>
                          );
                        })}
                      </div>

                      {/* Footer: Jump to Current Month */}
                      <div className="pt-1.5 border-t border-slate-100 flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            const nowYm = new Date().toISOString().slice(0, 7);
                            setYearMonth(nowYm);
                            setCalendarYear(Number(nowYm.slice(0, 4)));
                            setCalendarOpen(false);
                          }}
                          className="w-full py-1.5 px-2.5 rounded-md bg-teal-50 border border-teal-200 text-teal-900 font-medium hover:bg-teal-100 transition text-center"
                        >
                          {locale === 'pl' ? 'Dzisiaj / Bieżący miesiąc' : 'Jump to Current Month'} (
                          {new Date().toISOString().slice(0, 7)})
                        </button>
                      </div>
                    </div>
                  </>
                )}

                {/* Foldable Period Selector Button (Unfolds 1M / 3M / 6M / 12M / 5Y / 10Y on click) */}
                <button
                  type="button"
                  onClick={() => {
                    setHorizonMenuOpen((prev) => !prev);
                    setCalendarOpen(false);
                    setQuickMenuOpen(false);
                  }}
                  title={t.zoomLabel}
                  className={`inline-flex items-center gap-1 px-2 py-1.5 text-[11px] font-mono-num font-semibold rounded-r-md transition ${
                    budgetHorizon > 1 || horizonMenuOpen
                      ? 'bg-teal-700 text-white'
                      : 'bg-slate-50 text-teal-800 hover:bg-teal-50'
                  }`}
                >
                  <span>
                    {budgetHorizon === 60
                      ? '5Y'
                      : budgetHorizon === 120
                      ? '10Y'
                      : `${budgetHorizon}M`}
                  </span>
                  <ChevronDown className="w-3 h-3 opacity-80" />
                </button>

                {horizonMenuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-20"
                      onClick={() => setHorizonMenuOpen(false)}
                    />
                    <div className="absolute right-0 top-full mt-1.5 z-30 bg-white border border-slate-200 rounded-lg shadow-lg p-1.5 flex items-center gap-1">
                      {(
                        [
                          [1, '1M'],
                          [3, '3M'],
                          [6, '6M'],
                          [12, '12M'],
                          [60, '5Y'],
                          [120, '10Y'],
                        ] as Array<[1 | 3 | 6 | 12 | 60 | 120, string]>
                      ).map(([hVal, hLabel]) => (
                        <button
                          key={hVal}
                          type="button"
                          onClick={() => {
                            setBudgetHorizon(hVal);
                            setHorizonMenuOpen(false);
                          }}
                          className={`px-2.5 py-1 rounded text-xs font-mono-num transition ${
                            budgetHorizon === hVal
                              ? 'bg-teal-700 text-white font-semibold'
                              : 'text-slate-700 hover:bg-slate-100'
                          }`}
                        >
                          {hLabel}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Compact Icon Button: Privacy Shield Toggle */}
            <button
              type="button"
              onClick={togglePrivacy}
              title={`Toggle Friends %-Only Privacy View (Shortcut: P) · ${privacyMode ? t.pctOnly : cur}`}
              className={`inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-md border text-xs font-mono-num whitespace-nowrap shrink-0 transition ${
                privacyMode
                  ? 'border-teal-700 bg-teal-700 text-white'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
              }`}
            >
              {privacyMode ? <EyeOff className="w-3.5 h-3.5 shrink-0" /> : <Eye className="w-3.5 h-3.5 shrink-0" />}
              <span className="hidden sm:inline">{privacyMode ? '%' : cur}</span>
            </button>

            {/* Foldable Workspace, Language & Account Menu Button */}
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => {
                  setQuickMenuOpen((prev) => !prev);
                  setHorizonMenuOpen(false);
                }}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs font-medium whitespace-nowrap transition ${
                  quickMenuOpen
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                }`}
                title="Workspaces, Language & Account Menu"
              >
                <Building2 className="w-3.5 h-3.5 text-teal-700 shrink-0" />
                <span className="hidden sm:inline max-w-[115px] truncate">
                  {scope === 'all'
                    ? t.allWorkspaces
                    : readableWorkspaces.find((w) => w.id === scope)?.name || t.allWorkspaces}
                </span>
                <span className="text-[10px] font-mono-num uppercase px-1 py-0.2 rounded bg-slate-100 text-slate-600 hidden lg:inline">
                  {locale}
                </span>
                <ChevronDown className="w-3.5 h-3.5 opacity-70 shrink-0" />
              </button>

              {quickMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-20"
                    onClick={() => setQuickMenuOpen(false)}
                  />
                  <div className="absolute right-0 top-full mt-1.5 z-30 w-64 bg-white border border-slate-200 rounded-xl shadow-xl p-3 space-y-3 text-xs">
                    {/* 1. Workspace Switcher */}
                    <div className="space-y-1.5">
                      <div className="text-[10px] font-mono-num uppercase tracking-wider text-slate-400 font-semibold">
                        Workspace
                      </div>
                      <div className="space-y-1 max-h-44 overflow-y-auto">
                        <button
                          type="button"
                          onClick={() => {
                            setScope('all');
                            setSelectedPotId(null);
                            setQuickMenuOpen(false);
                          }}
                          className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-left transition ${
                            scope === 'all'
                              ? 'bg-teal-50 text-teal-900 font-semibold border border-teal-200'
                              : 'text-slate-700 hover:bg-slate-100'
                          }`}
                        >
                          <span>🌐 {t.allWorkspaces}</span>
                          {scope === 'all' && <Check className="w-3.5 h-3.5 text-teal-700" />}
                        </button>
                        {readableWorkspaces.map((ws) => (
                          <button
                            key={ws.id}
                            type="button"
                            onClick={() => {
                              setScope(ws.id);
                              setSelectedPotId(null);
                              setQuickMenuOpen(false);
                            }}
                            className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-left transition ${
                              scope === ws.id
                                ? 'bg-teal-50 text-teal-900 font-semibold border border-teal-200'
                                : 'text-slate-700 hover:bg-slate-100'
                            }`}
                          >
                            <span className="truncate">
                              {ws.kind === 'company' ? '🏢 ' : ws.kind === 'shared' ? '🏠 ' : '👤 '}
                              {ws.name}
                            </span>
                            {scope === ws.id && <Check className="w-3.5 h-3.5 text-teal-700 shrink-0" />}
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={() => {
                            setQuickMenuOpen(false);
                            setModal({ kind: 'workspace' });
                          }}
                          className="w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-teal-800 hover:bg-teal-50 font-medium"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span className="truncate">{t.createWorkspaceBtn}</span>
                        </button>
                      </div>
                    </div>

                    {/* 2. Period Zoom (Mobile & Quick Access) */}
                    <div className="border-t border-slate-100 pt-2.5 space-y-1.5">
                      <div className="text-[10px] font-mono-num uppercase tracking-wider text-slate-400 font-semibold">
                        {t.zoomLabel}
                      </div>
                      <div className="grid grid-cols-6 gap-1">
                        {(
                          [
                            [1, '1M'],
                            [3, '3M'],
                            [6, '6M'],
                            [12, '12M'],
                            [60, '5Y'],
                            [120, '10Y'],
                          ] as Array<[1 | 3 | 6 | 12 | 60 | 120, string]>
                        ).map(([hVal, hLabel]) => (
                          <button
                            key={hVal}
                            type="button"
                            onClick={() => {
                              setBudgetHorizon(hVal);
                              setQuickMenuOpen(false);
                            }}
                            className={`py-1 rounded text-[11px] font-mono-num text-center transition ${
                              budgetHorizon === hVal
                                ? 'bg-teal-700 text-white font-semibold'
                                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                            }`}
                          >
                            {hLabel}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* 3. Language & Privacy Toggles */}
                    <div className="border-t border-slate-100 pt-2.5 grid grid-cols-2 gap-1.5">
                      <button
                        type="button"
                        onClick={() => void switchLocale(locale === 'en' ? 'pl' : 'en')}
                        className="flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-200 bg-slate-50 hover:bg-slate-100 font-mono-num uppercase text-slate-700"
                      >
                        <Globe className="w-3.5 h-3.5 text-teal-700" />
                        <span>{locale === 'en' ? 'EN → PL' : 'PL → EN'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={togglePrivacy}
                        className={`flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md border font-mono-num ${
                          privacyMode
                            ? 'border-teal-700 bg-teal-700 text-white'
                            : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        {privacyMode ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        <span>{privacyMode ? t.pctOnly : cur}</span>
                      </button>
                    </div>

                    {/* 4. User Profile & Sign Out */}
                    <div className="border-t border-slate-100 pt-2.5 flex items-center justify-between">
                      {auth?.authMode === 'dev' && auth.devUsers ? (
                        <select
                          value={boot.user.handle}
                          onChange={async (e) => {
                            await apiFetch('/api/auth/dev-switch', {
                              method: 'POST',
                              body: JSON.stringify({ handle: e.target.value }),
                            });
                            setQuickMenuOpen(false);
                            await reloadAll();
                          }}
                          className="border border-slate-200 bg-white rounded px-2 py-1 text-xs font-medium text-slate-700 w-full"
                        >
                          {auth.devUsers.map((u) => (
                            <option key={u.handle} value={u.handle}>
                              {u.displayName} (dev)
                            </option>
                          ))}
                        </select>
                      ) : (
                        <>
                          <div className="truncate">
                            <div className="font-semibold text-slate-800 truncate">{boot.user.displayName}</div>
                            <div className="text-[10px] font-mono-num text-slate-400">@{boot.user.handle}</div>
                          </div>
                          <button
                            type="button"
                            onClick={async () => {
                              const r = await apiFetch<{ endSessionUrl: string }>('/api/auth/logout', {
                                method: 'POST',
                              });
                              window.location.href = r.endSessionUrl || '/';
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-600 hover:text-white transition"
                          >
                            <LogOut className="w-3.5 h-3.5" />
                            <span>{t.signOut}</span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Mobile Tab Strip (Even 5-Column Grid, Zero Horizontal Scrollbar) */}
        <div className="grid grid-cols-5 md:hidden border-t border-slate-200 px-2 py-1 gap-1">
          {(
            [
              ['overview', t.tabOverview],
              ['timeline', t.tabTimeline],
              ['pots', t.tabPots],
              ['wealth', t.tabWealth],
              ['settings', t.tabSettings],
            ] as Array<[TabKey, string]>
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`py-1 rounded text-[11px] font-medium text-center truncate ${
                tab === k ? 'bg-slate-900 text-white' : 'text-slate-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {errorMsg && (
        <div className="max-w-6xl mx-auto w-full px-4 sm:px-6 pt-3">
          <div className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded-md flex justify-between">
            <span>{errorMsg}</span>
            <button type="button" onClick={() => setErrorMsg(null)}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="max-w-6xl mx-auto w-full px-4 sm:px-6 py-6 flex-1 space-y-6">
        {/* ======================== TAB 1: OVERVIEW ======================== */}
        {tab === 'overview' && (
          <>
            {/* KPI Strip (scales dynamically when zoomed out to 3M / 6M / 12M / 5Y / 10Y) */}
            {(() => {
              const hs = budget.horizonSummary;
              const isMulti = budgetHorizon > 1 && hs;
              const periodTag =
                budgetHorizon === 3
                  ? ' (3M)'
                  : budgetHorizon === 6
                  ? ' (6M)'
                  : budgetHorizon === 12
                  ? ' (12M)'
                  : budgetHorizon === 60
                  ? ' (5Y)'
                  : budgetHorizon === 120
                  ? ' (10Y)'
                  : '';
              const kpiInc = isMulti ? hs.totalIncomeMinor : budget.kpis.totalIncomeMinor;
              const kpiSpd = isMulti ? hs.totalSpendMinor : budget.kpis.potPlannedTotalMinor;
              const kpiPrs = isMulti
                ? budget.kpis.totalPreserveSliceMinor * budgetHorizon
                : budget.kpis.totalPreserveSliceMinor;
              const kpiSav = isMulti ? hs.totalSavedMinor : budget.kpis.netMonthlySurplusMinor;
              const kpiRate = isMulti ? hs.savingsRatePct : budget.kpis.savingsRatePct;

              return (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <div className="bg-white border border-slate-200 rounded-lg p-4">
                    <div className="text-[11px] font-mono-num uppercase tracking-wider text-slate-400">
                      {t.kpiIncome}
                      {periodTag}
                    </div>
                    <div className="mt-1 text-2xl font-mono-num font-semibold text-slate-900">
                      {privacyMode ? '100.0%' : fmt(kpiInc)}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {isMulti && !privacyMode
                        ? `${t.horizonAvgMoLabel}: ${fmt(hs.avgMonthlyIncomeMinor)}`
                        : t.kpiActiveStreams(budget.incomes.length)}
                    </div>
                  </div>

                  <div className="bg-white border border-slate-200 rounded-lg p-4">
                    <div className="text-[11px] font-mono-num uppercase tracking-wider text-slate-400">
                      {t.kpiPlannedSpent}
                      {periodTag}
                    </div>
                    <div className="mt-1 text-2xl font-mono-num font-semibold text-slate-900">{fmt(kpiSpd)}</div>
                    <div className="mt-1 text-xs text-slate-500">
                      {isMulti && !privacyMode ? `${t.horizonAvgMoLabel}: ${fmt(hs.avgMonthlySpendMinor)}` : t.kpiPlannedSub}
                    </div>
                  </div>

                  <div className="bg-white border border-slate-200 rounded-lg p-4">
                    <div className="text-[11px] font-mono-num uppercase tracking-wider text-teal-700">
                      {t.kpiPreserve}
                      {periodTag}
                    </div>
                    <div className="mt-1 text-2xl font-mono-num font-semibold text-teal-800">{fmt(kpiPrs)}</div>
                    <div className="mt-1 text-xs text-slate-500">{t.kpiPreserveSub}</div>
                  </div>

                  <div className="bg-white border border-slate-200 rounded-lg p-4">
                    <div className="text-[11px] font-mono-num uppercase tracking-wider text-slate-400">
                      {t.kpiSurplus}
                      {periodTag}
                    </div>
                    <div
                      className={`mt-1 text-2xl font-mono-num font-semibold ${
                        kpiSav >= 0 ? 'text-emerald-700' : 'text-amber-700'
                      }`}
                    >
                      {fmt(kpiSav)}
                    </div>
                    <div className="mt-1 text-xs text-slate-500 font-mono-num">
                      {t.kpiSavingsRate}: {kpiRate}%
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Live Bank & Runway Accounts Bar (Folded by default; shows Total vs Locked Annual Reserves vs Real Free Cash) */}
            <section className="bg-white border border-slate-200 rounded-lg px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setAccountsFolded((prev) => !prev)}
                  className="flex items-center gap-2 text-left group"
                >
                  {accountsFolded ? (
                    <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-teal-700 shrink-0" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-teal-700 shrink-0" />
                  )}
                  <Landmark className="w-3.5 h-3.5 text-teal-700 shrink-0" />
                  <span className="text-[11px] font-mono-num uppercase tracking-wider text-slate-700 font-semibold group-hover:text-teal-800">
                    {t.bankAccountsTitle} ({allAvailableAccounts.length})
                  </span>
                  <span className="text-[11px] font-mono-num text-slate-500">
                    · {accountsFolded ? 'Click to open accounts & locked reserves' : 'Click to fold'}
                  </span>
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setAccountsFolded((prev) => !prev)}
                    className="px-2 py-1 rounded border border-slate-200 bg-[#FAF9F6] text-[11px] font-mono-num text-slate-700 hover:bg-slate-100"
                  >
                    {accountsFolded ? 'Open Accounts ▾' : 'Fold Accounts ▴'}
                  </button>
                  <button
                    type="button"
                    onClick={() => openTransferModal({ mode: 'single' })}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-teal-700 bg-teal-700 text-white text-[11px] font-medium hover:bg-teal-800 transition"
                  >
                    <ArrowLeftRight className="w-3 h-3" /> {t.moveMoneyBtn}
                  </button>
                  <button
                    type="button"
                    onClick={() => setModal({ kind: 'account' })}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 bg-white text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Plus className="w-3 h-3" /> {t.addAccountBtn}
                  </button>
                </div>
              </div>

              {!accountsFolded && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 mt-3 pt-2.5 border-t border-slate-100">
                  {allAvailableAccounts.map((acc) => {
                    const stat = budget.accountAnalytics?.find((a) => a.accountId === acc.id);
                    const hasLocked = (stat?.lockedPreserveDisplayMinor ?? 0) > 0;
                    const hasDeficit = stat && !stat.isPrePaydaySufficient && stat.unpaidPrePaydayDisplayMinor > 0;
                    return (
                      <div
                        key={acc.id}
                        onClick={() => openEntityDrawer('account', acc.id)}
                        className={`border rounded-md px-3 py-2.5 cursor-pointer flex flex-col justify-between gap-2 transition ${
                          hasDeficit
                            ? 'border-amber-300 bg-amber-50/40 hover:border-amber-500'
                            : hasLocked
                            ? 'border-teal-300 bg-teal-50/30 hover:border-teal-600'
                            : 'border-slate-200 bg-[#FAF9F6]/60 hover:border-teal-700/50'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-slate-900 truncate">{acc.name}</div>
                            <div className="text-[11px] text-slate-400 truncate">
                              {acc.institution || acc.currency}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="font-mono-num text-xs font-semibold text-slate-900">
                              {formatDisplayValue(acc.balanceMinor, { currency: acc.currency, privacyMode })}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                openEntityDrawer('account', acc.id);
                              }}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-300 bg-white text-[10px] font-medium text-slate-700 hover:bg-slate-900 hover:text-white transition"
                            >
                              <Pencil className="w-2.5 h-2.5" /> {t.editBtn}
                            </button>
                          </div>
                        </div>

                        {stat && (hasLocked || stat.unpaidPrePaydayDisplayMinor > 0 || stat.pocketMoneyTargetMinor > 0) && (
                          <div className="pt-1.5 border-t border-slate-200/70 space-y-1 text-[10px] font-mono-num">
                            {hasLocked && (
                              <div className="flex items-center justify-between text-teal-900">
                                <span>🔒 Planned Annual Reserves:</span>
                                <span className="font-semibold">
                                  {fmt(stat.lockedPreserveDisplayMinor)} · Free: {fmt(stat.trueAvailableDisplayMinor)}
                                </span>
                              </div>
                            )}
                            {stat.unpaidPrePaydayDisplayMinor > 0 && (
                              <div
                                className={`flex items-center justify-between ${
                                  stat.isPrePaydaySufficient ? 'text-slate-600' : 'text-amber-800 font-semibold'
                                }`}
                              >
                                <span>Pre-Payday Bills Due:</span>
                                <span>
                                  {fmt(stat.unpaidPrePaydayDisplayMinor)}{' '}
                                  {!stat.isPrePaydaySufficient && `(Need +${fmt(Math.abs(stat.netPrePaydayDisplayMinor))})`}
                                </span>
                              </div>
                            )}
                            {stat.pocketMoneyTargetDisplayMinor > 0 && (
                              <div className="flex items-center justify-between text-indigo-800">
                                <span>🎯 Pocket Money Left:</span>
                                <span>
                                  {fmt(stat.pocketMoneyRemainingDisplayMinor)} / {fmt(stat.pocketMoneyTargetDisplayMinor)}
                                </span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Cashflow Sankey Card with Unlimited-Depth Unfold, Multi-Layer Account/Workspace Routing & Two-Track Payday Bridge */}
            <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                    {t.sankeyTitle}
                  </h2>
                  <p className="text-xs text-slate-400">{t.sankeySub}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSankeyShowLayers((prev) => !prev)}
                    className={`px-2.5 py-1.5 rounded border text-xs font-mono-num transition ${
                      sankeyShowLayers
                        ? 'border-teal-700 bg-teal-700 text-white font-semibold'
                        : 'border-slate-200 bg-[#FAF9F6] text-slate-700 hover:bg-slate-100'
                    }`}
                    title="Toggle intermediate Bank Account -> Workspace Scope mixing layers on the Sankey diagram"
                  >
                    {sankeyShowLayers
                      ? 'Layers: Accounts → Workspaces → Pots'
                      : 'Layers: Direct to Pots'}
                  </button>
                  {(sankeyExpandedPots.size > 0 || sankeyExpandedExps.size > 0) && (
                    <button
                      type="button"
                      onClick={() => {
                        setSankeyExpandedPots(new Set());
                        setSankeyExpandedExps(new Set());
                      }}
                      className="px-2.5 py-1.5 rounded border border-teal-200 bg-teal-50/70 text-teal-800 text-xs font-mono-num hover:bg-teal-100"
                    >
                      {t.foldAll} ({sankeyExpandedPots.size + sankeyExpandedExps.size})
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setModal({ kind: 'pot' })}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <FolderTree className="w-3.5 h-3.5" /> {t.newPotBtn}
                  </button>
                  <button
                    type="button"
                    onClick={() => setModal({ kind: 'income' })}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-emerald-700/30 bg-emerald-50/50 text-xs font-medium text-emerald-900 hover:bg-emerald-100/70"
                  >
                    <Plus className="w-3.5 h-3.5" /> {t.addIncomeBtn}
                  </button>
                  <button
                    type="button"
                    onClick={() => setModal({ kind: 'expense' })}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Plus className="w-3.5 h-3.5" /> {t.btnAddExpense}
                  </button>
                  <button
                    type="button"
                    onClick={() => setModal({ kind: 'obligation' })}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-slate-900 text-white text-xs font-medium hover:bg-slate-800"
                  >
                    <Plus className="w-3.5 h-3.5" /> {t.btnAddBillGoal}
                  </button>
                </div>
              </div>

              {/* Legend explaining Solid vs Brighter Solid with Dotted Border Payday Bridge */}
              <div className="text-[11px] font-mono-num text-slate-500 bg-slate-50/80 border border-slate-100 rounded px-3 py-1.5 flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-1.5 text-emerald-800 font-medium">
                  <span className="w-3.5 h-2 rounded-xs bg-emerald-700/60 inline-block" />
                  {t.sankeyLegendSolid}
                </span>
                <span className="inline-flex items-center gap-1.5 text-rose-700">
                  <span className="w-3.5 h-2 rounded-xs bg-rose-200/70 border border-dashed border-rose-600 inline-block" />
                  {t.sankeyLegendDotted}
                </span>
              </div>

              {/* Inline Quick-Add / Item-to-Pot Promotion Form when '+' is clicked on any Sankey node */}
              {quickAddTarget && (
                <QuickAddInline
                  target={quickAddTarget}
                  defaultCurrency={cur}
                  yearMonth={yearMonth}
                  accounts={allAvailableAccounts}
                  t={t}
                  onCancel={() => setQuickAddTarget(null)}
                  onCreated={async ({ expandPotIds }) => {
                    setQuickAddTarget(null);
                    if (expandPotIds.length > 0) {
                      setSankeyExpandedPots((prev) => new Set([...prev, ...expandPotIds]));
                    }
                    await reloadAll();
                  }}
                />
              )}

              <CashflowSankeyChart
                incomes={budget.incomes}
                accounts={allAvailableAccounts}
                workspaces={boot.workspaces}
                showRoutingLayers={sankeyShowLayers}
                cashflowBridge={budget.cashflowBridge}
                potTree={budget.potTree}
                obligations={budget.allObligations ?? budget.obligations}
                expenses={budget.allExpenses ?? budget.expenses}
                totalIncomeMinor={budget.kpis.totalIncomeMinor}
                potPlannedTotalMinor={budget.kpis.potPlannedTotalMinor}
                netMonthlySurplusMinor={budget.kpis.netMonthlySurplusMinor}
                currency={cur}
                privacyMode={privacyMode}
                expandedPotIds={sankeyExpandedPots}
                expandedExpenseIds={sankeyExpandedExps}
                onTogglePot={handleToggleSankeyPot}
                onToggleExpense={handleToggleSankeyExpense}
                onSetExpandedPots={setSankeyExpandedPots}
                onSetExpandedExpenses={setSankeyExpandedExps}
                onQuickAdd={(target) => setQuickAddTarget(target)}
                onInspectItem={(kind, id) => openEntityDrawer(kind, id)}
                t={t}
              />
            </section>

            {/* Multi-Period Historical Performance & Trajectory (3M / 6M / 12M / 5Y / 10Y) + Active Sinking Reserves */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <section className="lg:col-span-2 bg-white border border-slate-200 rounded-lg p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-xs font-mono-num uppercase tracking-wider text-slate-600 font-semibold">
                      {budget.horizonSummary
                        ? t.horizonHistoryTitle(
                            budgetHorizon === 1
                              ? '6M'
                              : budgetHorizon === 60
                              ? '5Y'
                              : budgetHorizon === 120
                              ? '10Y'
                              : `${budgetHorizon}M`,
                            `${budget.horizonSummary.startYearMonth} → ${budget.horizonSummary.endYearMonth}`
                          )
                        : t.trend6mTitle}
                    </h3>
                    <p className="text-[11px] text-slate-400">{t.horizonHistorySub}</p>
                  </div>
                  <div className="inline-flex items-center border border-slate-200 bg-[#FAF9F6] rounded-md p-0.5 text-[11px] font-mono-num">
                    {(
                      [
                        [1, '1M'],
                        [3, '3M'],
                        [6, '6M'],
                        [12, '12M'],
                        [60, '5Y'],
                        [120, '10Y'],
                      ] as Array<[1 | 3 | 6 | 12 | 60 | 120, string]>
                    ).map(([hVal, hLabel]) => (
                      <button
                        key={hVal}
                        type="button"
                        onClick={() => setBudgetHorizon(hVal)}
                        className={`px-2 py-0.5 rounded transition ${
                          budgetHorizon === hVal
                            ? 'bg-teal-700 text-white font-semibold'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {hLabel}
                      </button>
                    ))}
                  </div>
                </div>
                {budget.horizonSummary ? (
                  <HorizonHistoryChart
                    summary={budget.horizonSummary}
                    currency={cur}
                    privacyMode={privacyMode}
                    t={t}
                  />
                ) : (
                  <SixMonthTrendChart data={budget.trend6m} currency={cur} privacyMode={privacyMode} />
                )}
              </section>

              <section className="bg-white border border-slate-200 rounded-lg p-5 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                      {t.preserveGoalsTitle}
                    </h3>
                    <PiggyBank className="w-4 h-4 text-teal-700" />
                  </div>
                  <p className="text-[11px] text-slate-500 mb-3">{t.preserveExplainer}</p>
                  <div className="space-y-2.5">
                    {(budget.allObligations ?? budget.obligations)
                      .filter((o) => o.cadence !== 'monthly' && (o.preserveDisplayMinor > 0 || o.preservedDisplayMinor > 0))
                      .map((ob) => {
                        const progressPct =
                          ob.amountMinor > 0 ? Math.min(100, Math.round((ob.preservedMinor / ob.amountMinor) * 100)) : 0;
                        const isUnfolded = preserveExpandedIds.has(ob.id);
                        const potLabel = ob.potId ? potBreadcrumbs.get(ob.potId)?.pathString || 'Annual Goal' : 'Annual Goal';
                        return (
                          <div
                            key={ob.id}
                            className="border border-slate-200 rounded-md p-2.5 bg-[#FAF9F6]/80 hover:border-teal-600/50 transition"
                          >
                            <div
                              onClick={() =>
                                setPreserveExpandedIds((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(ob.id)) next.delete(ob.id);
                                  else next.add(ob.id);
                                  return next;
                                })
                              }
                              className="flex items-center justify-between text-xs cursor-pointer"
                            >
                              <span className="font-medium text-slate-900 inline-flex items-center gap-1.5 min-w-0">
                                {isUnfolded ? (
                                  <ChevronDown className="w-3.5 h-3.5 text-teal-700 shrink-0" />
                                ) : (
                                  <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                )}
                                <span className="truncate">{ob.name}</span>
                              </span>
                              <span className="font-mono-num font-semibold text-teal-800 shrink-0">
                                +{fmt(ob.preserveDisplayMinor)}/mo
                              </span>
                            </div>

                            <div className="flex items-center justify-between text-[11px] text-slate-500 mt-1 font-mono-num">
                              <span>
                                {t.dueLabel} {ob.nextDueDate} ({ob.metrics.monthsUntilDue}
                                {t.monthsLeft})
                              </span>
                              <span className="font-semibold text-slate-700">
                                {t.preservedPct} {progressPct}%{' '}
                                {!privacyMode && `(${fmt(ob.preservedDisplayMinor)} / ${fmt(ob.targetDisplayMinor)})`}
                              </span>
                            </div>
                            <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden mt-1.5">
                              <div className="h-full bg-teal-700" style={{ width: `${progressPct}%` }} />
                            </div>

                            {isUnfolded && (
                              <div className="mt-2.5 pt-2 border-t border-slate-200/80 space-y-1.5 text-[11px] font-mono-num">
                                <div className="flex items-center justify-between text-slate-600">
                                  <span>Category / Pot:</span>
                                  <span className="font-medium text-slate-800 truncate max-w-[180px]">{potLabel}</span>
                                </div>
                                <div className="flex items-center justify-between text-slate-600">
                                  <span>Sitting on Account:</span>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const targetAcc = ob.preserveAccountId || ob.accountId;
                                      if (targetAcc) openEntityDrawer('account', targetAcc);
                                    }}
                                    className="font-semibold text-teal-800 hover:underline"
                                  >
                                    🏦 {ob.preserveAccountName || ob.accountName || 'Lloyds Standard Saver'}
                                  </button>
                                </div>
                                <div className="flex items-center justify-between text-slate-600">
                                  <span>Remaining Still Needed:</span>
                                  <span className="font-semibold text-amber-800">
                                    {fmt(Math.max(0, ob.targetDisplayMinor - ob.preservedDisplayMinor))} by {ob.nextDueDate}
                                  </span>
                                </div>
                                <div className="flex items-center justify-end gap-2 pt-1">
                                  <button
                                    type="button"
                                    onClick={() => openEntityDrawer('obligation', ob.id)}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-slate-300 bg-white text-[10px] font-sans font-medium text-slate-700 hover:bg-slate-900 hover:text-white transition"
                                  >
                                    <Pencil className="w-2.5 h-2.5" /> Edit Reserve / Account
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>
                </div>
              </section>
            </div>
          </>
        )}

        {/* ======================== TAB 2: TIMELINE & SUFFICIENCY ======================== */}
        {tab === 'timeline' && (
          <>
            {/* Per-Account Timeline Selector + Folded-by-Default Bank & Runway Accounts Section */}
            <section className="bg-white border border-slate-200 rounded-lg px-4 py-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setAccountsFolded((prev) => !prev)}
                  className="flex items-center gap-2 text-left group"
                >
                  {accountsFolded ? (
                    <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-teal-700 shrink-0" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-teal-700 shrink-0" />
                  )}
                  <span className="text-[11px] font-mono-num uppercase tracking-wider text-slate-600 font-semibold flex items-center gap-1.5 group-hover:text-teal-800">
                    <Landmark className="w-3.5 h-3.5 text-teal-700" /> {t.bankAccountsTitle} ({allAvailableAccounts.length})
                  </span>
                  <span className="text-[11px] font-mono-num text-slate-500">
                    · Total:{' '}
                    <strong className="text-slate-900">
                      {fmt(
                        (budget.accountAnalytics || []).reduce((s, a) => s + a.displayBalanceMinor, 0) ||
                          budget.runway.runwayCashMinor
                      )}
                    </strong>
                  </span>
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setAccountsFolded((prev) => !prev)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 bg-[#FAF9F6] text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                  >
                    {accountsFolded ? 'Open Accounts & Reserves' : 'Fold Accounts'}
                  </button>
                  <button
                    type="button"
                    onClick={() => openTransferModal({ mode: 'single' })}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-teal-700 bg-teal-700 text-white text-[11px] font-medium hover:bg-teal-800 transition"
                  >
                    <ArrowLeftRight className="w-3 h-3" /> {t.moveMoneyBtn}
                  </button>
                  <button
                    type="button"
                    onClick={() => setModal({ kind: 'account' })}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Plus className="w-3 h-3" /> {t.addAccountBtn}
                  </button>
                </div>
              </div>

              {/* Per-Account Timeline Filter Pills (Default: All Accounts Combined, or click any account to isolate its timeline & money flow) */}
              <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-slate-100">
                <span className="text-[10px] font-mono-num uppercase tracking-wider text-slate-400 mr-1">
                  Timeline Source:
                </span>
                <button
                  type="button"
                  onClick={() => setTimelineAccountId('all')}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition ${
                    timelineAccountId === 'all'
                      ? 'bg-slate-900 text-white shadow-sm'
                      : 'bg-[#FAF9F6] text-slate-700 border border-slate-200 hover:border-teal-600/50'
                  }`}
                >
                  <span>All Accounts (Combined)</span>
                  <span className="font-mono-num text-[11px] opacity-80">
                    {fmt(
                      (budget.accountAnalytics || []).reduce((s, a) => s + a.displayBalanceMinor, 0) ||
                        budget.runway.runwayCashMinor
                    )}
                  </span>
                </button>
                {allAvailableAccounts.map((acc) => {
                  const analytics = (budget.accountAnalytics || []).find((a) => a.accountId === acc.id);
                  const isSelected = timelineAccountId === acc.id;
                  const hasShortfall = analytics && !analytics.isPrePaydaySufficient;
                  const hasLocked = analytics && analytics.lockedPreserveDisplayMinor > 0;
                  return (
                    <button
                      key={acc.id}
                      type="button"
                      onClick={() => setTimelineAccountId(isSelected ? 'all' : acc.id)}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition ${
                        isSelected
                          ? 'bg-teal-800 text-white shadow-sm'
                          : 'bg-[#FAF9F6] text-slate-700 border border-slate-200 hover:border-teal-600/50'
                      }`}
                      title={
                        hasLocked
                          ? `${acc.name}: Free ${fmt(analytics.trueAvailableDisplayMinor)} (${fmt(analytics.lockedPreserveDisplayMinor)} locked for annual renewals)`
                          : acc.name
                      }
                    >
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${
                          hasShortfall
                            ? 'bg-amber-500'
                            : hasLocked
                            ? 'bg-teal-500'
                            : 'bg-emerald-500'
                        }`}
                      />
                      <span className="truncate max-w-[165px]">{acc.name.split('—')[0].trim()}</span>
                      <span
                        className={`font-mono-num text-[11px] ${
                          isSelected ? 'text-teal-100' : 'text-slate-900 font-semibold'
                        }`}
                      >
                        {formatDisplayValue(acc.balanceMinor, { currency: acc.currency, privacyMode })}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Expanded Detailed Account Cards (with Locked Annual Reserves vs Real Free Cash & Pocket Money) */}
              {!accountsFolded && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 pt-2 border-t border-slate-100">
                  {allAvailableAccounts.map((acc) => {
                    const analytics = (budget.accountAnalytics || []).find((a) => a.accountId === acc.id);
                    const hasLocked = analytics && analytics.lockedPreserveDisplayMinor > 0;
                    const hasShortfall = analytics && !analytics.isPrePaydaySufficient;
                    const isSelected = timelineAccountId === acc.id;
                    return (
                      <div
                        key={acc.id}
                        onClick={() => openEntityDrawer('account', acc.id)}
                        className={`flex flex-col justify-between gap-2 px-3 py-2.5 rounded-md border cursor-pointer transition ${
                          isSelected
                            ? 'border-teal-700 bg-teal-50/30 ring-1 ring-teal-700/30'
                            : hasShortfall
                            ? 'border-amber-300 bg-amber-50/30 hover:border-amber-500'
                            : 'border-slate-200 bg-[#FAF9F6]/70 hover:border-teal-600/50'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-slate-800 truncate">{acc.name}</div>
                            <div className="text-[10px] text-slate-400 truncate">{acc.institution}</div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="font-mono-num text-xs font-semibold text-slate-900">
                              {formatDisplayValue(acc.balanceMinor, { currency: acc.currency, privacyMode })}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                openEntityDrawer('account', acc.id);
                              }}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-slate-300 bg-white text-[10px] font-medium text-slate-700 hover:bg-slate-900 hover:text-white hover:border-slate-900 transition"
                            >
                              <Pencil className="w-2.5 h-2.5" /> {t.editBtn}
                            </button>
                          </div>
                        </div>

                        {analytics && (hasLocked || analytics.unpaidPrePaydayDisplayMinor > 0 || analytics.pocketMoneyTargetMinor > 0) && (
                          <div className="pt-1.5 border-t border-slate-200/70 space-y-1 text-[10px] font-mono-num">
                            {hasLocked && (
                              <>
                                <div className="flex items-center justify-between text-amber-800">
                                  <span>🔒 Planned Annual Reserves:</span>
                                  <span className="font-semibold">-{fmt(analytics.lockedPreserveDisplayMinor)}</span>
                                </div>
                                <div className="flex items-center justify-between text-emerald-800">
                                  <span>✓ Real Free Available Cash:</span>
                                  <span className="font-semibold">{fmt(analytics.trueAvailableDisplayMinor)}</span>
                                </div>
                                {analytics.lockedItems.length > 0 && (
                                  <div className="text-[9.5px] text-slate-500 pl-2 border-l-2 border-amber-300 space-y-0.5 mt-0.5">
                                    {analytics.lockedItems.map((li) => (
                                      <div key={li.obligationId} className="flex justify-between">
                                        <span className="truncate max-w-[160px]">{li.name}</span>
                                        <span>
                                          {fmt(li.preservedDisplayMinor)} / {fmt(li.targetDisplayMinor)}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </>
                            )}
                            {analytics.unpaidPrePaydayDisplayMinor > 0 && (
                              <div className="flex items-center justify-between text-slate-600">
                                <span>Pre-Payday Bills Due:</span>
                                <span className={hasShortfall ? 'text-rose-700 font-semibold' : 'text-slate-800'}>
                                  {fmt(analytics.unpaidPrePaydayDisplayMinor)}
                                  {hasShortfall ? ` (Need +${fmt(Math.abs(analytics.netPrePaydayDisplayMinor))})` : ''}
                                </span>
                              </div>
                            )}
                            {analytics.pocketMoneyTargetMinor > 0 && (
                              <div className="flex items-center justify-between text-teal-800">
                                <span>🎯 Pocket Money Left:</span>
                                <span className="font-semibold">
                                  {formatDisplayValue(analytics.pocketMoneyRemainingMinor, {
                                    currency: acc.currency,
                                    privacyMode,
                                  })}{' '}
                                  /{' '}
                                  {formatDisplayValue(analytics.pocketMoneyTargetMinor, {
                                    currency: acc.currency,
                                    privacyMode,
                                  })}
                                </span>
                              </div>
                            )}
                          </div>
                        )}

                        <div className="flex items-center justify-between pt-1 border-t border-slate-100">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setTimelineAccountId(isSelected ? 'all' : acc.id);
                            }}
                            className={`text-[10px] font-medium px-2 py-0.5 rounded transition ${
                              isSelected
                                ? 'bg-teal-800 text-white'
                                : 'bg-white border border-slate-200 text-teal-800 hover:bg-teal-50'
                            }`}
                          >
                            {isSelected ? '✓ Viewing This Account Timeline' : 'Filter Timeline to Account'}
                          </button>
                          {acc.isPrimaryRunway && (
                            <span className="text-[9.5px] font-mono-num text-slate-400">Runway Active</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Automated Financial Advisory & Smart Money Movement Recommendations */}
            {budget.advisories && budget.advisories.length > 0 && (
              <section className="bg-white border border-slate-200 rounded-lg px-4 py-3 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setAdvisoryOpen((prev) => !prev)}
                    className="flex items-center gap-2 text-left group"
                  >
                    {advisoryOpen ? (
                      <ChevronDown className="w-4 h-4 text-teal-700 shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-teal-700 shrink-0" />
                    )}
                    <span className="text-[11px] font-mono-num uppercase tracking-wider text-slate-700 font-semibold flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-amber-600" /> Automated Financial Advisory & Money Flow Alerts (
                      {budget.advisories.length})
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setAdvisoryOpen((prev) => !prev)}
                    className="text-[11px] text-slate-500 hover:text-slate-800"
                  >
                    {advisoryOpen ? 'Hide Advisory' : 'Show Advisory'}
                  </button>
                </div>

                {advisoryOpen && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 pt-1">
                    {budget.advisories.map((adv) => {
                      const isCritical = adv.severity === 'critical';
                      const isWarn = adv.severity === 'warning' || isCritical;
                      const isGood = adv.severity === 'good';
                      return (
                        <div
                          key={adv.id}
                          className={`rounded-lg border p-3 flex flex-col justify-between gap-2 ${
                            isCritical
                              ? 'bg-rose-50/70 border-rose-200 text-rose-950'
                              : isWarn
                              ? 'bg-amber-50/70 border-amber-200 text-amber-950'
                              : isGood
                              ? 'bg-emerald-50/60 border-emerald-200 text-emerald-950'
                              : 'bg-teal-50/50 border-teal-200 text-teal-950'
                          }`}
                        >
                          <div className="space-y-1">
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex items-center gap-1.5 text-xs font-semibold">
                                {isWarn ? (
                                  <AlertTriangle
                                    className={`w-4 h-4 shrink-0 ${isCritical ? 'text-rose-600' : 'text-amber-600'}`}
                                  />
                                ) : isGood ? (
                                  <PiggyBank className="w-4 h-4 text-emerald-600 shrink-0" />
                                ) : (
                                  <Landmark className="w-4 h-4 text-teal-700 shrink-0" />
                                )}
                                <span>{adv.title}</span>
                              </div>
                              {adv.amountDisplayMinor > 0 ? (
                                <span
                                  className={`font-mono-num text-xs font-bold px-2 py-0.5 rounded shrink-0 ${
                                    isCritical
                                      ? 'bg-rose-200/80 text-rose-950'
                                      : isWarn
                                      ? 'bg-amber-200/70 text-amber-950'
                                      : isGood
                                      ? 'bg-emerald-200/70 text-emerald-950'
                                      : 'bg-teal-200/70 text-teal-950'
                                  }`}
                                >
                                  {fmt(adv.amountDisplayMinor)}
                                </span>
                              ) : null}
                            </div>
                            <p className="text-[11px] leading-relaxed opacity-90">{adv.description}</p>
                          </div>

                          <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-black/5 text-[10px]">
                            <div className="flex flex-wrap items-center gap-1.5 font-mono-num">
                              {adv.kind === 'transfer_warning' && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      openTransferModal({
                                        mode: 'single',
                                        defaultSourceAccountId: adv.sourceAccountId || undefined,
                                        defaultDestAccountId: adv.accountId || undefined,
                                        defaultAmountMajor: Math.ceil(adv.amountDisplayMinor) / 100,
                                        defaultDescription: `Pre-payday top-up to ${adv.accountName || 'account'}`,
                                      })
                                    }
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-teal-800 text-white font-semibold hover:bg-teal-900 transition"
                                  >
                                    <ArrowLeftRight className="w-2.5 h-2.5" /> Move Funds Now
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const firstShortfallOb = budget.obligations.find(
                                        (o) =>
                                          !o.isPaidThisMonth &&
                                          o.metrics.isDueThisMonth &&
                                          (!adv.accountId || o.accountId === adv.accountId)
                                      );
                                      scrollToChecklistObligation(firstShortfallOb?.id ?? null);
                                    }}
                                    className="px-2 py-0.5 rounded bg-rose-700 text-white font-semibold hover:bg-rose-800 transition"
                                  >
                                    ↓ Scroll to Red Uncovered Payments
                                  </button>
                                </>
                              )}
                              {adv.accountName && (
                                <button
                                  type="button"
                                  onClick={() => adv.accountId && setTimelineAccountId(adv.accountId)}
                                  className="px-2 py-0.5 rounded bg-white/80 border border-black/10 hover:bg-slate-900 hover:text-white transition"
                                >
                                  🏦 Filter Timeline: {adv.accountName.split('—')[0].trim()}
                                </button>
                              )}
                              {adv.accountId && (
                                <button
                                  type="button"
                                  onClick={() => adv.accountId && openEntityDrawer('account', adv.accountId)}
                                  className="px-2 py-0.5 rounded bg-white/80 border border-black/10 hover:bg-slate-900 hover:text-white transition"
                                >
                                  <Pencil className="w-2.5 h-2.5 inline mr-0.5" />{' '}
                                  {adv.actionLabel || 'Configure Account / Pocket Money'}
                                </button>
                              )}
                            </div>
                            <span className="font-mono-num uppercase text-[9.5px] opacity-60">
                              {adv.kind.replace(/_/g, ' ')}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            )}

            {/* Pre-Payday Sufficiency Banner + Plotted Runway Curve + Folded-by-Default Expenses & Completed Payments Table */}
            {(() => {
              const primaryPaydayDay =
                budget.incomes.find((i) => i.paydayDay >= 20)?.paydayDay ||
                budget.incomes[0]?.paydayDay ||
                27;

              // Build map of accounts with pre-payday shortfall and track which specific obligations are uncovered
              const accAnalyticsMap = new Map(
                (budget.accountAnalytics || []).map((a) => [a.accountId, a])
              );
              const runningAccBalance = new Map<string, number>();
              for (const a of budget.accountAnalytics || []) {
                runningAccBalance.set(a.accountId, a.trueAvailableDisplayMinor);
              }

              const atRiskObInfo = new Map<
                string,
                {
                  accountName: string;
                  accountBalanceMinor: number;
                  accountDeficitMinor: number;
                  runningAfterMinor: number;
                  isDirectlyUncovered: boolean;
                }
              >();

              const sortedPrePaydayUnpaid = budget.obligations
                .filter((ob) => !ob.isPaidThisMonth && ob.metrics.isDueThisMonth && ob.dueDay < primaryPaydayDay)
                .sort((a, b) => a.dueDay - b.dueDay);

              for (const ob of sortedPrePaydayUnpaid) {
                if (!ob.accountId) continue;
                const stat = accAnalyticsMap.get(ob.accountId);
                if (!stat) continue;
                const prevBal = runningAccBalance.get(ob.accountId) ?? stat.trueAvailableDisplayMinor;
                const nextBal = prevBal - ob.dueDisplayMinor;
                runningAccBalance.set(ob.accountId, nextBal);

                if (!stat.isPrePaydaySufficient || nextBal < 0) {
                  atRiskObInfo.set(ob.id, {
                    accountName: stat.name,
                    accountBalanceMinor: stat.trueAvailableDisplayMinor,
                    accountDeficitMinor: Math.abs(stat.netPrePaydayDisplayMinor),
                    runningAfterMinor: nextBal,
                    isDirectlyUncovered: nextBal < 0,
                  });
                }
              }

              const atRiskObligations = sortedPrePaydayUnpaid.filter((ob) => atRiskObInfo.has(ob.id));
              const directlyUncoveredObligations = sortedPrePaydayUnpaid.filter(
                (ob) => atRiskObInfo.get(ob.id)?.isDirectlyUncovered
              );
              const firstWarningObId =
                directlyUncoveredObligations[0]?.id || atRiskObligations[0]?.id || null;
              const atRiskTotalMinor = atRiskObligations.reduce((s, o) => s + o.dueDisplayMinor, 0);

              const unpaidPrePaydayObs = budget.obligations.filter(
                (ob) => !ob.isPaidThisMonth && ob.metrics.isDueThisMonth && ob.dueDay < primaryPaydayDay
              );
              const unpaidPostPaydayObs = budget.obligations.filter(
                (ob) => !ob.isPaidThisMonth && ob.metrics.isDueThisMonth && ob.dueDay >= primaryPaydayDay
              );
              const unpaidPreserveObs = budget.obligations.filter(
                (ob) => !ob.isPaidThisMonth && !ob.metrics.isDueThisMonth
              );
              const unpaidAllObs = budget.obligations.filter((ob) => !ob.isPaidThisMonth);
              const paidAllObs = budget.obligations.filter((ob) => ob.isPaidThisMonth);

              const unpaidPrePaydaySumMinor = unpaidPrePaydayObs.reduce((s, o) => s + o.dueDisplayMinor, 0);
              const unpaidPostPaydaySumMinor = unpaidPostPaydayObs.reduce((s, o) => s + o.dueDisplayMinor, 0);
              const unpaidPreserveSumMinor = unpaidPreserveObs.reduce((s, o) => s + o.preserveDisplayMinor, 0);
              const paidSumMinor = paidAllObs.reduce(
                (s, o) => s + (o.metrics.isDueThisMonth ? o.dueDisplayMinor : o.preserveDisplayMinor),
                0
              );

              const renderChecklistRow = (ob: (typeof budget.obligations)[number], isFirstWarningAnchor: boolean) => {
                const isDueNow = ob.metrics.isDueThisMonth;
                const isMultiMonth = ob.intervalMonths > 1 || ob.cadence === 'annual';
                const isExpanded = preserveExpandedIds.has(ob.id);
                const progressPct =
                  ob.amountMinor > 0 ? Math.min(100, Math.round((ob.preservedMinor / ob.amountMinor) * 100)) : 0;
                const paidTimestamp =
                  ob.isPaidThisMonth && ob.occurrence?.paidAt
                    ? `${ob.occurrence.paidAt.slice(0, 10)} ${ob.occurrence.paidAt.slice(11, 16) || '09:00'}`
                    : null;
                const riskInfo = atRiskObInfo.get(ob.id);
                const isHighlighted = highlightedObId === ob.id;

                return (
                  <div
                    key={ob.id}
                    id={`checklist-ob-${ob.id}`}
                    className={`px-4 sm:px-5 py-3 space-y-2 transition-all ${
                      isHighlighted
                        ? 'bg-rose-100/90 ring-2 ring-rose-600'
                        : riskInfo
                        ? riskInfo.isDirectlyUncovered
                          ? 'bg-rose-50/80 border-l-4 border-l-rose-600 hover:bg-rose-50'
                          : 'bg-rose-50/40 border-l-4 border-l-amber-500 hover:bg-rose-50/60'
                        : ob.isPaidThisMonth
                        ? 'bg-emerald-50/20 hover:bg-slate-50/70'
                        : 'hover:bg-slate-50/70'
                    }`}
                  >
                    {isFirstWarningAnchor && <span id="checklist-shortfall-anchor" className="sr-only" />}
                    <div className="flex items-start justify-between gap-4">
                      {/* Left Column: Checkbox + Title + Wrapped/Truncated Metadata */}
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleTogglePaid(ob)}
                          className={`mt-0.5 shrink-0 transition ${
                            riskInfo ? 'text-rose-600 hover:text-rose-800' : 'text-slate-400 hover:text-teal-700'
                          }`}
                          title={
                            isDueNow
                              ? ob.isPaidThisMonth
                                ? t.markUnpaid
                                : t.markPaid
                              : ob.isPaidThisMonth
                              ? t.markPreserveUndone
                              : t.markPreserveDone
                          }
                        >
                          {ob.isPaidThisMonth ? (
                            <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                          ) : riskInfo ? (
                            <AlertTriangle className="w-5 h-5 text-rose-600" />
                          ) : (
                            <Circle className="w-5 h-5" />
                          )}
                        </button>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {isMultiMonth && (
                              <button
                                type="button"
                                onClick={() =>
                                  setPreserveExpandedIds((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(ob.id)) next.delete(ob.id);
                                    else next.add(ob.id);
                                    return next;
                                  })
                                }
                                className="text-slate-400 hover:text-teal-700 shrink-0"
                                title="Unfold annual reserve progress & storage account"
                              >
                                {isExpanded ? (
                                  <ChevronDown className="w-3.5 h-3.5 text-teal-700" />
                                ) : (
                                  <ChevronRight className="w-3.5 h-3.5" />
                                )}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => openEntityDrawer('obligation', ob.id)}
                              title={ob.name}
                              className={`text-sm font-medium text-left hover:underline truncate max-w-full sm:max-w-[440px] ${
                                ob.isPaidThisMonth
                                  ? 'line-through text-slate-500 hover:text-teal-800'
                                  : riskInfo
                                  ? 'text-rose-950 font-semibold hover:text-rose-800'
                                  : 'text-slate-900 hover:text-teal-800'
                              }`}
                            >
                              {ob.name}
                            </button>
                            <button
                              type="button"
                              onClick={() => openEntityDrawer('obligation', ob.id)}
                              title={t.editBtn}
                              className="p-1 rounded text-slate-400 hover:text-slate-800 hover:bg-slate-100 shrink-0"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                            {riskInfo && (
                              <span
                                className={`text-[10px] font-mono-num px-1.5 py-0.5 rounded font-semibold shrink-0 ${
                                  riskInfo.isDirectlyUncovered
                                    ? 'bg-rose-600 text-white'
                                    : 'bg-rose-100 text-rose-900 border border-rose-300'
                                }`}
                              >
                                {riskInfo.isDirectlyUncovered
                                  ? `⚠️ Uncovered on ${riskInfo.accountName.split('—')[0].trim()} (Shortfall -${fmt(
                                      riskInfo.accountDeficitMinor
                                    )})`
                                  : `⚠️ Low Account Balance (${riskInfo.accountName.split('—')[0].trim()})`}
                              </span>
                            )}
                            {!isDueNow && (
                              <span
                                className={`text-[10px] font-mono-num px-1.5 py-0.5 rounded shrink-0 ${
                                  ob.isPaidThisMonth
                                    ? 'bg-emerald-100 text-emerald-800 font-semibold'
                                    : 'bg-teal-50 text-teal-800 border border-teal-200'
                                }`}
                              >
                                {ob.isPaidThisMonth ? t.sinkingSetAsideDoneBadge : t.sinkingBadge}
                              </span>
                            )}
                            {ob.currency !== cur && !privacyMode && (
                              <span className="text-[10px] font-mono-num px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 shrink-0">
                                {ob.currency}
                              </span>
                            )}
                            {ob.manageUrl && (
                              <a
                                href={ob.manageUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-teal-700 hover:text-teal-900 inline-flex items-center gap-0.5 text-[11px] shrink-0"
                              >
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                          </div>

                          {/* Metadata Line: cleanly wraps pills onto next line & truncates long names with ... */}
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 font-mono-num mt-1">
                            <span className="whitespace-nowrap">
                              {isDueNow
                                ? `${t.dueLabel} ${yearMonth}-${String(ob.dueDay).padStart(2, '0')} · ${ob.cadence}`
                                : `${t.dueLabel} ${ob.nextDueDate} (${ob.metrics.monthsUntilDue}${t.monthsLeft}) · ${t.preservedPct} ${progressPct}%${
                                    !privacyMode
                                      ? ` (${fmt(ob.preservedDisplayMinor)} / ${fmt(ob.targetDisplayMinor)})`
                                      : ''
                                  }`}
                            </span>
                            {ob.accountName && (
                              <span
                                title={`Paid from: ${ob.accountName}`}
                                className={`inline-flex items-center gap-1 max-w-[240px] sm:max-w-[300px] truncate ${
                                  riskInfo ? 'text-rose-800 font-medium' : 'text-slate-600'
                                }`}
                              >
                                · 🏦 Paid from: {ob.accountName}
                              </span>
                            )}
                            {isMultiMonth && (ob.preserveAccountName || ob.accountName) && (
                              <span
                                title={`Reserve on: ${ob.preserveAccountName || ob.accountName}`}
                                className="inline-flex items-center gap-1 max-w-[240px] sm:max-w-[280px] truncate text-teal-800 font-medium"
                              >
                                · 🔒 Reserve on: {ob.preserveAccountName || ob.accountName}
                              </span>
                            )}
                            {ob.liabilityName && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (ob.liabilityId) openEntityDrawer('liability', ob.liabilityId);
                                }}
                                title={`Linked Liability: ${ob.liabilityName}`}
                                className="inline-flex items-center gap-1 max-w-[230px] sm:max-w-[280px] truncate text-amber-800 hover:underline font-medium"
                              >
                                · 🏠 <span className="truncate">{ob.liabilityName}</span>
                              </button>
                            )}
                            {paidTimestamp && (
                              <span className="text-emerald-700 font-semibold whitespace-nowrap">
                                · ✓ {paidTimestamp}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Right Column: Pinned Price (never wraps to left!) */}
                      <div className="shrink-0 text-right font-mono-num pl-2">
                        <div
                          className={`text-sm font-semibold whitespace-nowrap ${
                            riskInfo ? 'text-rose-700 font-bold' : 'text-slate-900'
                          }`}
                        >
                          {isDueNow ? fmt(ob.dueDisplayMinor) : `${fmt(ob.preserveDisplayMinor)}/mo`}
                        </div>
                        {!isDueNow && !privacyMode && (
                          <div className="text-[10px] text-slate-400 whitespace-nowrap">
                            {t.targetLabel} {fmt(ob.targetDisplayMinor)}
                          </div>
                        )}
                        {riskInfo && riskInfo.isDirectlyUncovered && !privacyMode && (
                          <div className="text-[10px] text-rose-600 font-semibold whitespace-nowrap">
                            Bal after: -{fmt(Math.abs(riskInfo.runningAfterMinor))}
                          </div>
                        )}
                      </div>
                    </div>

                    {isMultiMonth && isExpanded && (
                      <div className="ml-8 p-3 rounded-md bg-[#FAF9F6] border border-slate-200 space-y-2 text-xs font-mono-num">
                        <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-teal-600 rounded-full transition-all"
                            style={{ width: `${progressPct}%` }}
                          />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
                          <div>
                            <span className="text-slate-400 block">Progress Saved:</span>
                            <span className="font-semibold text-emerald-800">
                              {fmt(ob.preservedDisplayMinor)} of {fmt(ob.targetDisplayMinor)} ({progressPct}%)
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-400 block">Sitting on Account:</span>
                            <button
                              type="button"
                              onClick={() => {
                                const targetAccId = ob.preserveAccountId || ob.accountId;
                                if (targetAccId) openEntityDrawer('account', targetAccId);
                              }}
                              className="font-semibold text-teal-800 hover:underline text-left truncate max-w-full"
                            >
                              🏦 {ob.preserveAccountName || ob.accountName || 'Lloyds Standard Saver'}
                            </button>
                          </div>
                          <div>
                            <span className="text-slate-400 block">Pot / Category:</span>
                            <span className="font-semibold text-slate-700 truncate block">
                              {ob.potId ? potBreadcrumbs.get(ob.potId)?.pathString || '—' : '—'}
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              };

              return (
                <>
                  <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
                    {timelineAccountId !== 'all' && (
                      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-md bg-teal-50 border border-teal-200 text-xs text-teal-950">
                        <div className="flex items-center gap-2">
                          <Landmark className="w-4 h-4 text-teal-700 shrink-0" />
                          <span>
                            Showing isolated timeline & cashflow for{' '}
                            <strong>
                              {allAvailableAccounts.find((a) => a.id === timelineAccountId)?.name || timelineAccountId}
                            </strong>
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setTimelineAccountId('all')}
                          className="px-2 py-0.5 rounded bg-white border border-teal-300 text-[11px] font-medium text-teal-900 hover:bg-teal-800 hover:text-white transition"
                        >
                          Reset to All Accounts
                        </button>
                      </div>
                    )}

                    {/* Top Red Notification Banner for Accounts with Insufficient Funds Before Salary (Scrolls down to checklist items!) */}
                    {atRiskObligations.length > 0 && (
                      <div className="rounded-lg border border-rose-300 bg-rose-50/90 px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="space-y-1 min-w-0">
                          <div className="flex items-center gap-2 text-xs font-semibold text-rose-950">
                            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                            <span>
                              Account Shortfall Alert: {atRiskObligations.length} upcoming pre-payday payments (
                              {fmt(atRiskTotalMinor)}) are scheduled on an account without sufficient funds!
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                            {atRiskObligations.slice(0, 5).map((ob) => {
                              const r = atRiskObInfo.get(ob.id);
                              return (
                                <button
                                  key={ob.id}
                                  type="button"
                                  onClick={() => scrollToChecklistObligation(ob.id)}
                                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10.5px] font-mono-num transition ${
                                    r?.isDirectlyUncovered
                                      ? 'bg-rose-600 text-white font-semibold hover:bg-rose-700'
                                      : 'bg-white border border-rose-300 text-rose-900 hover:bg-rose-100'
                                  }`}
                                  title={`Click to scroll to ${ob.name}`}
                                >
                                  <span className="truncate max-w-[150px]">{ob.name}</span>
                                  <span>{fmt(ob.dueDisplayMinor)}</span>
                                </button>
                              );
                            })}
                            {atRiskObligations.length > 5 && (
                              <span className="text-[10.5px] font-mono-num text-rose-800">
                                +{atRiskObligations.length - 5} more
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => scrollToChecklistObligation(firstWarningObId)}
                          className="shrink-0 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-rose-700 text-white text-xs font-semibold hover:bg-rose-800 shadow-xs transition"
                        >
                          <span>Scroll to Uncovered Payments ↓</span>
                        </button>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-block w-2.5 h-2.5 rounded-full ${
                              budget.runway.isSufficient ? 'bg-emerald-600' : 'bg-amber-600'
                            }`}
                          />
                          <h2 className="text-sm font-semibold text-slate-900">
                            {budget.runway.isSufficient ? t.runwaySufficient : t.runwayShortfall}
                          </h2>
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5 font-mono-num">
                          {t.runwayCash}: {fmt(budget.runway.runwayCashMinor)} · {t.unpaidDue}:{' '}
                          {fmt(budget.runway.unpaidPrePaydayBillsMinor)} · {t.preserveTransfers}:{' '}
                          {fmt(budget.runway.totalPreserveSliceMinor)} · {t.remainingEnvelopes}:{' '}
                          {fmt(budget.runway.unallocatedEnvelopeRemainingMinor)}
                        </p>
                        {budget.cashflowBridge.nextMonthPreSalaryMinor > 0 && timelineAccountId === 'all' && (
                          <p className="text-xs text-rose-700 mt-1 font-mono-num">
                            {t.nextMonthReserveLabel}{' '}
                            <span className="font-semibold">{fmt(budget.cashflowBridge.nextMonthPreSalaryMinor)}</span>
                          </p>
                        )}
                      </div>

                      <div className="text-right font-mono-num">
                        <div className="text-[11px] uppercase text-slate-400">
                          {budget.runway.isSufficient ? t.projectedBuffer : t.requiredTopUp}
                        </div>
                        <div
                          className={`text-xl font-semibold ${
                            budget.runway.isSufficient
                              ? 'text-emerald-700'
                              : 'bg-amber-700 text-white px-2 py-0.5 rounded'
                          }`}
                        >
                          {budget.runway.isSufficient
                            ? fmt(budget.runway.prePaydayBufferMinor)
                            : fmt(budget.runway.shortfallMinor)}
                        </div>
                      </div>
                    </div>

                    <DailyRunwayChart
                      curve={budget.runway.dailyCurve}
                      openingBalanceMinor={budget.runway.openingBalanceMinor}
                      unallocatedAfterNextMonthMinor={
                        timelineAccountId === 'all' ? budget.runway.projectedAfterNextMonthReserveMinor : undefined
                      }
                      nextMonthReserveMinor={
                        timelineAccountId === 'all' ? budget.cashflowBridge.nextMonthPreSalaryMinor : undefined
                      }
                      currency={cur}
                      privacyMode={privacyMode}
                      t={t}
                      onSelectDay={() => setLedgerOpen(true)}
                    />

                    {/* Folded-by-Default Chronological Table of All Month Expenses & Completed Checklist Payments */}
                    <div className="border-t border-slate-200 pt-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => setLedgerOpen((prev) => !prev)}
                          className="flex items-center gap-2 text-left group"
                        >
                          {ledgerOpen ? (
                            <ChevronDown className="w-4 h-4 text-teal-700 shrink-0" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-teal-700 shrink-0" />
                          )}
                          <div>
                            <div className="text-xs font-mono-num uppercase tracking-wider text-slate-700 font-semibold group-hover:text-teal-800">
                              {t.ledgerFoldedTitle(budget.timelineLedger.length)}
                              {budgetHorizon > 1 && budget.horizonSummary
                                ? ` (${budget.horizonSummary.startYearMonth} → ${budget.horizonSummary.endYearMonth})`
                                : ` (${yearMonth})`}{' '}
                              ·{' '}
                              <span className="text-slate-900">
                                {fmt(budget.timelineLedger.reduce((s, e) => s + e.displayAmountMinor, 0))}
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-400">{t.ledgerFoldedSub}</div>
                          </div>
                        </button>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setModal({ kind: 'expense' })}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            <Plus className="w-3.5 h-3.5" /> {t.btnAddExpense}
                          </button>
                        </div>
                      </div>

                      {ledgerOpen && (
                        <div className="mt-3 border border-slate-200 rounded-lg overflow-x-auto max-h-[460px] overflow-y-auto bg-white">
                          {budget.timelineLedger.length === 0 ? (
                            <div className="p-4 text-xs text-slate-400 font-mono-num text-center">
                              {t.emptyLedgerMsg}
                            </div>
                          ) : (
                            <table className="w-full text-left border-collapse text-xs">
                              <thead className="sticky top-0 z-10">
                                <tr className="border-b border-slate-200 bg-[#FAF9F6] text-[10px] font-mono-num uppercase text-slate-500">
                                  <th className="py-2 px-3">{t.colDateTime}</th>
                                  <th className="py-2 px-3">{t.colItemMerchant}</th>
                                  <th className="py-2 px-3">{t.colPot}</th>
                                  <th className="py-2 px-3">{t.colAccount}</th>
                                  <th className="py-2 px-3">{t.colType}</th>
                                  <th className="py-2 px-3 text-right">{t.colAmount}</th>
                                  <th className="py-2 px-3 text-right">{t.colActions}</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-100">
                                {budget.timelineLedger.map((entry) => {
                                  const formattedTs = `${entry.date} ${entry.timestamp.slice(11, 16) || '12:00'}`;
                                  const potPath = entry.potId
                                    ? potBreadcrumbs.get(entry.potId)?.pathString || entry.potName
                                    : '—';
                                  const isInflow = entry.flowDirection === 'inflow';
                                  return (
                                    <tr key={entry.id} className="hover:bg-slate-50/80">
                                      <td className="py-2.5 px-3 font-mono-num text-[11px] text-slate-600 whitespace-nowrap">
                                        {formattedTs}
                                      </td>
                                      <td className="py-2.5 px-3">
                                        <button
                                          type="button"
                                          onClick={() => openEntityDrawer(entry.entityType, entry.entityId)}
                                          className="font-medium text-slate-900 hover:text-teal-800 hover:underline text-left"
                                        >
                                          {entry.title}
                                        </button>
                                        {entry.subtitle && (
                                          <div className="text-[11px] text-slate-400 truncate max-w-[220px]">
                                            {entry.subtitle}
                                          </div>
                                        )}
                                      </td>
                                      <td className="py-2.5 px-3">
                                        <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-600">
                                          <span
                                            className="w-2 h-2 rounded-full shrink-0"
                                            style={{ backgroundColor: entry.potColor }}
                                          />
                                          <span className="truncate max-w-[160px]">{potPath}</span>
                                        </span>
                                      </td>
                                      <td className="py-2.5 px-3 whitespace-nowrap text-[11px] text-slate-600">
                                        {entry.accountName ? (
                                          <button
                                            type="button"
                                            onClick={() =>
                                              entry.accountId && openEntityDrawer('account', entry.accountId)
                                            }
                                            className="inline-flex items-center gap-1 text-slate-700 hover:text-teal-800 hover:underline"
                                          >
                                            <Landmark className="w-3 h-3 text-teal-700 shrink-0" />
                                            <span>{entry.accountName}</span>
                                          </button>
                                        ) : (
                                          <span className="text-slate-400">—</span>
                                        )}
                                      </td>
                                      <td className="py-2.5 px-3 whitespace-nowrap">
                                        <span
                                          className={`inline-flex px-2 py-0.5 rounded text-[10px] font-mono-num ${
                                            isInflow
                                              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                                              : entry.kind === 'expense'
                                              ? 'bg-rose-50 text-rose-800 border border-rose-200'
                                              : entry.kind === 'paid_bill'
                                              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                                              : 'bg-teal-50 text-teal-800 border border-teal-200'
                                          }`}
                                        >
                                          {isInflow
                                            ? t.typeDeposit
                                            : entry.kind === 'expense'
                                            ? t.typeExpense
                                            : entry.kind === 'paid_bill'
                                            ? t.typePaidBill
                                            : t.typeSinkingSetAside}
                                        </span>
                                      </td>
                                      <td
                                        className={`py-2.5 px-3 text-right font-mono-num font-semibold whitespace-nowrap ${
                                          isInflow ? 'text-emerald-700' : 'text-slate-900'
                                        }`}
                                      >
                                        {isInflow ? '+' : '-'}
                                        {fmt(entry.displayAmountMinor)}
                                        {entry.currency !== cur && !privacyMode && (
                                          <div className="text-[10px] text-slate-400 font-normal">
                                            {CURRENCY_SYMBOLS[entry.currency]}
                                            {(entry.amountMinor / 100).toFixed(2)}
                                          </div>
                                        )}
                                      </td>
                                      <td className="py-2.5 px-3 text-right whitespace-nowrap">
                                        <div className="inline-flex items-center gap-1.5">
                                          <button
                                            type="button"
                                            onClick={() => openEntityDrawer(entry.entityType, entry.entityId)}
                                            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 bg-white text-[11px] text-slate-700 hover:bg-slate-900 hover:text-white transition"
                                          >
                                            <Pencil className="w-3 h-3" /> {t.editBtn}
                                          </button>
                                          {entry.entityType === 'expense' ? (
                                            <button
                                              type="button"
                                              onClick={async () => {
                                                if (!confirm(`Delete "${entry.title}"?`)) return;
                                                await apiFetch(`/api/expenses/${entry.entityId}`, { method: 'DELETE' });
                                                await reloadAll();
                                              }}
                                              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-rose-200 bg-rose-50/60 text-[11px] text-rose-700 hover:bg-rose-600 hover:text-white transition"
                                            >
                                              <Trash2 className="w-3 h-3" /> {t.deleteBtn}
                                            </button>
                                          ) : (
                                            <button
                                              type="button"
                                              onClick={async () => {
                                                await apiFetch(`/api/obligations/${entry.entityId}/toggle-paid`, {
                                                  method: 'POST',
                                                  body: JSON.stringify({ yearMonth, paid: false }),
                                                });
                                                await reloadAll();
                                              }}
                                              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-amber-200 bg-amber-50/70 text-[11px] text-amber-800 hover:bg-amber-600 hover:text-white transition"
                                            >
                                              <RotateCcw className="w-3 h-3" /> {t.undoBtn}
                                            </button>
                                          )}
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          )}
                        </div>
                      )}
                    </div>
                  </section>

                  {/* Expected Salary & Income Arrivals (Tick when received in bank account!) */}
                  <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                    <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between bg-emerald-50/40">
                      <div>
                        <h3 className="text-xs font-mono-num uppercase tracking-wider text-emerald-900 font-semibold">
                          {t.incomeArrivalsTitle} ({yearMonth})
                        </h3>
                      </div>
                      <button
                        type="button"
                        onClick={() => setModal({ kind: 'income' })}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-emerald-700/30 bg-white text-emerald-900 text-xs font-medium hover:bg-emerald-50"
                      >
                        <Plus className="w-3.5 h-3.5" /> {t.addIncomeBtn}
                      </button>
                    </div>
                    <div className="divide-y divide-slate-100">
                      {budget.incomes.map((inc) => (
                        <div
                          key={inc.id}
                          className="px-4 sm:px-5 py-3 flex items-start justify-between gap-4 hover:bg-slate-50/70"
                        >
                          <div className="flex items-start gap-3 min-w-0 flex-1">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleToggleIncomeReceived(inc)}
                              className="mt-0.5 shrink-0 text-slate-400 hover:text-emerald-700 transition"
                              title={inc.isReceivedThisMonth ? t.markIncomePending : t.markIncomeReceived}
                            >
                              {inc.isReceivedThisMonth ? (
                                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                              ) : (
                                <Circle className="w-5 h-5 text-emerald-600/60" />
                              )}
                            </button>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => openEntityDrawer('income', inc.id)}
                                  className="text-sm font-medium text-slate-900 hover:text-teal-800 hover:underline text-left truncate max-w-full sm:max-w-[420px]"
                                >
                                  {inc.name}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openEntityDrawer('income', inc.id)}
                                  title={t.editBtn}
                                  className="p-1 rounded text-slate-400 hover:text-slate-800 hover:bg-slate-100 shrink-0"
                                >
                                  <Pencil className="w-3 h-3" />
                                </button>
                                <span
                                  className={`text-[10px] font-mono-num px-1.5 py-0.5 rounded shrink-0 ${
                                    inc.isReceivedThisMonth
                                      ? 'bg-emerald-100 text-emerald-800 font-semibold'
                                      : 'bg-amber-50 text-amber-800 border border-amber-200 border-dashed'
                                  }`}
                                >
                                  {inc.isReceivedThisMonth
                                    ? t.statusReceivedBadge
                                    : t.statusAwaitingBadge(inc.paydayDay)}
                                </span>
                              </div>
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 font-mono-num mt-0.5">
                                <span>
                                  {inc.expectedDate} · {inc.cadence}
                                </span>
                                {inc.accountName && (
                                  <span className="text-slate-600 truncate max-w-[260px]">· 🏦 {inc.accountName}</span>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="shrink-0 font-mono-num text-sm font-semibold text-emerald-800 whitespace-nowrap pl-2">
                            +{fmt(inc.monthlyDisplayMinor)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>

                  {/* Chronological Monthly Payment Checklist & Unified Sinking Set-Aside ('Preserve') */}
                  <section id="checklist-section" className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                    <div className="px-5 py-3.5 border-b border-slate-200 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <h3 className="text-xs font-mono-num uppercase tracking-wider text-slate-600 font-semibold">
                            {t.checklistTitle} ({yearMonth})
                          </h3>
                          <p className="text-xs text-slate-400">{t.checklistSub}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          {paidAllObs.length > 0 && (
                            <button
                              type="button"
                              onClick={() => setChecklistPaidFolded((prev) => !prev)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-emerald-200 bg-emerald-50/70 text-emerald-900 text-xs font-medium hover:bg-emerald-100 transition"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                              <span>
                                {checklistPaidFolded
                                  ? `Show Paid (${paidAllObs.length})`
                                  : `Fold Paid (${paidAllObs.length})`}
                              </span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setModal({ kind: 'obligation' })}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-slate-900 text-white text-xs font-medium"
                          >
                            <Plus className="w-3.5 h-3.5" /> {t.addScheduledBtn}
                          </button>
                        </div>
                      </div>

                      {/* Summary Calculation Strip: Upcoming Before Salary vs After Salary vs Sinking vs Paid */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 pt-1">
                        <div
                          onClick={() => firstWarningObId && scrollToChecklistObligation(firstWarningObId)}
                          className={`rounded-md border p-2.5 font-mono-num ${
                            atRiskObligations.length > 0
                              ? 'border-rose-300 bg-rose-50/70 cursor-pointer hover:border-rose-500'
                              : 'border-amber-200 bg-amber-50/40'
                          }`}
                        >
                          <div className="text-[10px] uppercase tracking-wider text-slate-500 flex items-center justify-between">
                            <span>Unpaid Before Salary (1st–{primaryPaydayDay - 1}th)</span>
                            {atRiskObligations.length > 0 && (
                              <span className="text-rose-700 font-bold">⚠️ {atRiskObligations.length} At Risk</span>
                            )}
                          </div>
                          <div
                            className={`text-sm font-bold mt-0.5 ${
                              atRiskObligations.length > 0 ? 'text-rose-700' : 'text-slate-900'
                            }`}
                          >
                            {fmt(unpaidPrePaydaySumMinor)}
                          </div>
                          <div className="text-[10px] text-slate-500">
                            {unpaidPrePaydayObs.length} scheduled bills before payday
                          </div>
                        </div>

                        <div className="rounded-md border border-slate-200 bg-[#FAF9F6] p-2.5 font-mono-num">
                          <div className="text-[10px] uppercase tracking-wider text-slate-500">
                            Upcoming On/After Salary ({primaryPaydayDay}th+)
                          </div>
                          <div className="text-sm font-bold text-slate-900 mt-0.5">
                            {fmt(unpaidPostPaydaySumMinor)}
                          </div>
                          <div className="text-[10px] text-slate-500">
                            {unpaidPostPaydayObs.length} bills covered by incoming salary
                          </div>
                        </div>

                        <div className="rounded-md border border-teal-200 bg-teal-50/40 p-2.5 font-mono-num">
                          <div className="text-[10px] uppercase tracking-wider text-teal-800">
                            Pending Sinking ("Preserve")
                          </div>
                          <div className="text-sm font-bold text-teal-900 mt-0.5">
                            {fmt(unpaidPreserveSumMinor)}/mo
                          </div>
                          <div className="text-[10px] text-teal-700">
                            {unpaidPreserveObs.length} annual/multi-month slices pending
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => setChecklistPaidFolded((prev) => !prev)}
                          className="rounded-md border border-emerald-200 bg-emerald-50/40 p-2.5 font-mono-num text-left hover:bg-emerald-50 transition"
                        >
                          <div className="text-[10px] uppercase tracking-wider text-emerald-800 flex items-center justify-between">
                            <span>Completed This Month</span>
                            <span>{checklistPaidFolded ? 'Unfold ▾' : 'Fold ▴'}</span>
                          </div>
                          <div className="text-sm font-bold text-emerald-800 mt-0.5">{fmt(paidSumMinor)}</div>
                          <div className="text-[10px] text-emerald-700">
                            ✓ {paidAllObs.length} items already paid ({checklistPaidFolded ? 'folded' : 'open'})
                          </div>
                        </button>
                      </div>

                      {/* Clear explanation of 'Preserve' (Monthly Sinking Set-Aside) */}
                      <div className="text-[11px] text-teal-900 bg-teal-50/70 border border-teal-200/70 rounded px-3 py-1.5 flex items-start gap-2">
                        <PiggyBank className="w-3.5 h-3.5 text-teal-700 shrink-0 mt-0.5" />
                        <span>{t.preserveExplainer}</span>
                      </div>
                    </div>

                    {/* Active / Unpaid Obligations List */}
                    <div className="divide-y divide-slate-100">
                      {unpaidAllObs.length === 0 ? (
                        <div className="px-5 py-6 text-center text-xs font-mono-num text-emerald-800 bg-emerald-50/30">
                          ✓ All {paidAllObs.length} scheduled payments and sinking reserves for {yearMonth} are marked as
                          completed!
                        </div>
                      ) : (
                        unpaidAllObs.map((ob) => renderChecklistRow(ob, ob.id === firstWarningObId))
                      )}
                    </div>

                    {/* Folded-by-Default Completed / Already Paid Section */}
                    {paidAllObs.length > 0 && (
                      <div className="border-t border-slate-200 bg-emerald-50/20">
                        <button
                          type="button"
                          onClick={() => setChecklistPaidFolded((prev) => !prev)}
                          className="w-full px-5 py-3 flex items-center justify-between gap-2 text-left hover:bg-emerald-50/50 transition"
                        >
                          <div className="flex items-center gap-2">
                            {checklistPaidFolded ? (
                              <ChevronRight className="w-4 h-4 text-emerald-700 shrink-0" />
                            ) : (
                              <ChevronDown className="w-4 h-4 text-emerald-700 shrink-0" />
                            )}
                            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                            <span className="text-xs font-mono-num uppercase tracking-wider font-semibold text-emerald-900">
                              Already Paid & Completed This Month ({paidAllObs.length}) · {fmt(paidSumMinor)}
                            </span>
                          </div>
                          <span className="text-[11px] font-mono-num text-emerald-800">
                            {checklistPaidFolded ? 'Click to unfold completed items ▾' : 'Click to fold ▴'}
                          </span>
                        </button>

                        {!checklistPaidFolded && (
                          <div className="divide-y divide-slate-100 border-t border-emerald-200/60 bg-white">
                            {paidAllObs.map((ob) => renderChecklistRow(ob, false))}
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                </>
              );
            })()}
          </>
        )}

        {/* ======================== TAB 3: POTS, ENVELOPES & UNLIMITED SUB-POTS ======================== */}
        {tab === 'pots' && (
          <>
            <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                    {t.propAllocationTitle}
                  </h2>
                  <p className="text-xs text-slate-400">{t.propAllocationSub}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setModal({ kind: 'pot', defaultParentId: selectedPotId })}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <FolderTree className="w-3.5 h-3.5" /> {t.newPotBtn}
                  </button>
                  <button
                    type="button"
                    onClick={() => setModal({ kind: 'expense', defaultPotId: selectedPotId })}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-slate-900 text-white text-xs font-medium"
                  >
                    <Plus className="w-3.5 h-3.5" /> {t.logSpendBtn}
                  </button>
                </div>
              </div>

              <PotProportionStrip
                nodes={budget.potTree}
                pots={budget.pots}
                obligations={budget.obligations}
                expenses={budget.expenses}
                currency={cur}
                privacyMode={privacyMode}
                selectedPotId={selectedPotId}
                onSelectPot={setSelectedPotId}
                t={t}
              />
            </section>

            {quickAddTarget && (
              <QuickAddInline
                target={quickAddTarget}
                defaultCurrency={cur}
                yearMonth={yearMonth}
                accounts={allAvailableAccounts}
                t={t}
                onCancel={() => setQuickAddTarget(null)}
                onCreated={async ({ expandPotIds }) => {
                  setQuickAddTarget(null);
                  if (expandPotIds.length > 0) {
                    setCollapsedTreePots((prev) => {
                      const next = new Set(prev);
                      for (const id of expandPotIds) next.delete(id);
                      return next;
                    });
                    setSelectedPotId(expandPotIds[expandPotIds.length - 1]);
                  }
                  await reloadAll();
                }}
              />
            )}

            {/* Hierarchical Unlimited-Depth Pots & Items Tree + Subtree Receipts Panel */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                  <span className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                    {t.nestedPotsTitle}
                  </span>
                  <div className="flex items-center gap-2 text-[11px] font-mono-num">
                    <button
                      type="button"
                      onClick={() => setCollapsedTreePots(new Set())}
                      className="text-teal-700 hover:underline"
                    >
                      {t.expandAll}
                    </button>
                    <span className="text-slate-300">·</span>
                    <button
                      type="button"
                      onClick={() => setCollapsedTreePots(new Set(budget.pots.map((p) => p.id)))}
                      className="text-slate-500 hover:underline"
                    >
                      {t.collapseAll}
                    </button>
                  </div>
                </div>

                <div className="divide-y divide-slate-100 max-h-[540px] overflow-y-auto">
                  {visiblePotTreeRows.map(({ node, depth, directObs, directExps, hasChildren, isCollapsed, spentPaidMinor, plannedUpcomingMinor }) => (
                    <React.Fragment key={node.pot.id}>
                      {/* Pot Row */}
                      <div
                        className={`px-4 py-2.5 flex items-center justify-between text-xs hover:bg-slate-50 group ${
                          selectedPotId === node.pot.id ? 'bg-teal-50/50' : ''
                        }`}
                      >
                        <div className="flex items-center gap-1.5 min-w-0" style={{ paddingLeft: `${depth * 18}px` }}>
                          {hasChildren ? (
                            <button
                              type="button"
                              onClick={() => toggleTreePotCollapse(node.pot.id)}
                              className="p-0.5 text-slate-400 hover:text-slate-800"
                            >
                              {isCollapsed ? (
                                <ChevronRight className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronDown className="w-3.5 h-3.5" />
                              )}
                            </button>
                          ) : (
                            <span className="w-4" />
                          )}
                          <span
                            className="w-2.5 h-2.5 rounded-xs shrink-0"
                            style={{ backgroundColor: node.pot.color }}
                          />
                          <button
                            type="button"
                            onClick={() => setSelectedPotId((curId) => (curId === node.pot.id ? null : node.pot.id))}
                            className="font-medium text-slate-800 hover:text-teal-800 truncate text-left"
                          >
                            {node.pot.name}
                          </button>
                          {node.pot.envelopeMode && (
                            <span className="text-[10px] font-mono-num px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800">
                              {t.envelopeBadge}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => openEntityDrawer('pot', node.pot.id)}
                            title={t.editBtn}
                            className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded border border-slate-300 bg-white text-slate-500 hover:bg-slate-900 hover:text-white hover:border-slate-900 transition"
                          >
                            <Pencil className="w-2.5 h-2.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setQuickAddTarget({
                                targetKind: 'pot',
                                potId: node.pot.id,
                                potName: node.pot.name,
                                workspaceId: node.pot.workspaceId,
                                currency: node.pot.currency,
                                color: node.pot.color,
                              })
                            }
                            title={t.qaTooltipPot}
                            className="inline-flex items-center justify-center w-4 h-4 rounded border border-teal-600/40 bg-white text-teal-700 hover:bg-teal-700 hover:text-white transition"
                          >
                            <Plus className="w-2.5 h-2.5 stroke-[2.5]" />
                          </button>
                        </div>

                        <div className="text-right font-mono-num shrink-0 pl-2">
                          <div className="font-semibold text-slate-900">{fmt(node.effectiveTotalDisplayMinor)}</div>
                          {(spentPaidMinor > 0 || plannedUpcomingMinor > 0) && (
                            <div className="flex items-center justify-end gap-1.5 text-[10px] mt-0.5">
                              {spentPaidMinor > 0 && (
                                <span className="text-emerald-700 font-medium">✓ {fmt(spentPaidMinor)} spent</span>
                              )}
                              {spentPaidMinor > 0 && plannedUpcomingMinor > 0 && (
                                <span className="text-slate-300">·</span>
                              )}
                              {plannedUpcomingMinor > 0 && (
                                <span className="text-amber-700 font-medium">⏳ {fmt(plannedUpcomingMinor)} planned</span>
                              )}
                            </div>
                          )}
                          {node.pot.envelopeMode && node.unallocatedEnvelopeDisplayMinor > 0 && (
                            <div className="text-[10px] text-slate-400">
                              {fmt(node.itemizedSpendDisplayMinor)} {t.loggedLabel} ·{' '}
                              {fmt(node.unallocatedEnvelopeDisplayMinor)} {t.estLeftLabel}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Direct Leaf Obligations & Expenses inside this Pot (clicking '+' promotes item into a Pot!) */}
                      {!isCollapsed &&
                        directObs.map((ob) => {
                          const dueIso = ob.metrics.isDueThisMonth
                            ? `${yearMonth}-${String(Math.max(1, Math.min(31, ob.dueDay || 1))).padStart(2, '0')}`
                            : ob.nextDueDate;
                          const paidDate = (ob.occurrence?.bankDate || ob.occurrence?.paidAt || '').slice(0, 10);
                          return (
                            <div
                              key={ob.id}
                              className="px-4 py-1.5 flex items-center justify-between text-[11px] bg-[#FAF9F6]/60 hover:bg-slate-50 group"
                            >
                              <div
                                className="flex items-center gap-1.5 min-w-0"
                                style={{ paddingLeft: `${(depth + 1) * 18 + 14}px` }}
                              >
                                <span
                                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                    ob.isPaidThisMonth ? 'bg-emerald-600' : 'bg-amber-500'
                                  }`}
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    setDrawer({
                                      entityType: 'obligation',
                                      entityId: ob.id,
                                      workspaceId: ob.workspaceId,
                                      title: ob.name,
                                      subtitle: `${ob.cadence} · ${t.dueLabel} ${ob.nextDueDate}`,
                                      manageUrl: ob.manageUrl,
                                      portalUrl: ob.portalUrl,
                                      referenceNumber: ob.referenceNumber,
                                      notes: ob.notes,
                                      currency: ob.currency,
                                    })
                                  }
                                  className={`hover:underline truncate text-left ${
                                    ob.isPaidThisMonth ? 'text-slate-600' : 'text-slate-900 font-medium'
                                  }`}
                                >
                                  {ob.name}
                                </button>
                                <span
                                  className={`text-[9.5px] font-mono-num px-1.5 py-0.2 rounded border shrink-0 ${
                                    ob.isPaidThisMonth
                                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                      : 'bg-amber-50 text-amber-800 border-amber-300 font-medium'
                                  }`}
                                >
                                  {ob.isPaidThisMonth
                                    ? `✓ Paid${paidDate ? ` ${paidDate}` : ''}`
                                    : ob.metrics.isDueThisMonth
                                      ? `⏳ Due ${dueIso}`
                                      : `⏳ Preserve · ${ob.nextDueDate}`}
                                </span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setQuickAddTarget({
                                      targetKind: 'obligation',
                                      itemId: ob.id,
                                      itemName: ob.name,
                                      workspaceId: ob.workspaceId,
                                      parentPotId: ob.potId,
                                      amountMinor: ob.amountMinor,
                                      currency: ob.currency,
                                    })
                                  }
                                  title={t.qaTooltipPromote}
                                  className="inline-flex items-center justify-center w-4 h-4 rounded border border-slate-300 bg-white text-slate-500 hover:bg-teal-700 hover:text-white hover:border-teal-700 transition"
                                >
                                  <Plus className="w-2.5 h-2.5 stroke-[2.5]" />
                                </button>
                              </div>
                              <span
                                className={`font-mono-num ${
                                  ob.isPaidThisMonth ? 'text-emerald-800 font-medium' : 'text-amber-900 font-semibold'
                                }`}
                              >
                                {fmt(ob.effectiveDisplayMinor)}
                              </span>
                            </div>
                          );
                        })}

                      {!isCollapsed &&
                        directExps.map((exp) => (
                          <div
                            key={exp.id}
                            className="px-4 py-1.5 flex items-center justify-between text-[11px] bg-[#FAF9F6]/60 hover:bg-slate-50 group"
                          >
                            <div
                              className="flex items-center gap-1.5 min-w-0"
                              style={{ paddingLeft: `${(depth + 1) * 18 + 14}px` }}
                            >
                              <span className="w-1.5 h-1.5 rounded-full bg-teal-600 shrink-0" />
                              <button
                                type="button"
                                onClick={() =>
                                  setDrawer({
                                    entityType: 'expense',
                                    entityId: exp.id,
                                    workspaceId: exp.workspaceId,
                                    title: exp.merchant,
                                    subtitle: `${exp.spentDate} · ${exp.description}`,
                                    portalUrl: exp.portalUrl,
                                    items: exp.items,
                                    currency: exp.currency,
                                  })
                                }
                                className="text-slate-700 hover:underline truncate text-left"
                              >
                                {exp.merchant}
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setQuickAddTarget({
                                    targetKind: 'expense',
                                    itemId: exp.id,
                                    itemName: exp.merchant,
                                    workspaceId: exp.workspaceId,
                                    parentPotId: exp.potId,
                                    amountMinor: exp.amountMinor,
                                    currency: exp.currency,
                                  })
                                }
                                title={t.qaTooltipPromote}
                                className="inline-flex items-center justify-center w-4 h-4 rounded border border-slate-300 bg-white text-slate-500 hover:bg-teal-700 hover:text-white hover:border-teal-700 transition"
                              >
                                <Plus className="w-2.5 h-2.5 stroke-[2.5]" />
                              </button>
                            </div>
                            <span className="font-mono-num text-slate-600">{fmt(exp.displayAmountMinor)}</span>
                          </div>
                        ))}
                    </React.Fragment>
                  ))}
                </div>
              </section>

              {/* Subtree-Filtered Receipts & Actionable Bills */}
              <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                  <span className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                    {t.receiptsBillsTitle}
                    {selectedPotId && potBreadcrumbs.get(selectedPotId)
                      ? ` · ${potBreadcrumbs.get(selectedPotId)!.pathString}`
                      : ''}
                  </span>
                  {selectedPotId && (
                    <button
                      type="button"
                      onClick={() => setSelectedPotId(null)}
                      className="text-[11px] text-teal-700 hover:underline"
                    >
                      {t.clearFilter}
                    </button>
                  )}
                </div>

                <div className="divide-y divide-slate-100 max-h-[540px] overflow-y-auto">
                  {budget.expenses
                    .filter((e) => !activeSubtreePotIds || (e.potId && activeSubtreePotIds.has(e.potId)))
                    .map((exp) => (
                      <div
                        key={exp.id}
                        onClick={() =>
                          setDrawer({
                            entityType: 'expense',
                            entityId: exp.id,
                            workspaceId: exp.workspaceId,
                            title: exp.merchant,
                            subtitle: `${exp.spentDate} · ${exp.description}`,
                            portalUrl: exp.portalUrl,
                            items: exp.items,
                            currency: exp.currency,
                          })
                        }
                        className="px-4 py-3 flex items-center justify-between hover:bg-slate-50 cursor-pointer"
                      >
                        <div>
                          <div className="flex items-center gap-2 text-xs font-medium text-slate-900">
                            <span>{exp.merchant}</span>
                            {exp.source === 'mcp' && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 font-mono-num">
                                MCP
                              </span>
                            )}
                            {exp.items.length > 0 && (
                              <span className="text-[10px] text-slate-400 font-mono-num">
                                {t.subItemsCount(exp.items.length)}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {exp.spentDate} · {exp.description || t.btnAddExpense}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 font-mono-num text-xs font-semibold text-slate-800">
                          <span>
                            {privacyMode
                              ? fmt(exp.displayAmountMinor)
                              : `${CURRENCY_SYMBOLS[exp.currency]}${(exp.amountMinor / 100).toFixed(2)}`}
                          </span>
                          <Paperclip className="w-3.5 h-3.5 text-slate-400" />
                        </div>
                      </div>
                    ))}

                  {budget.obligations
                    .filter((o) => !activeSubtreePotIds || (o.potId && activeSubtreePotIds.has(o.potId)))
                    .map((ob) => {
                      const dueIso = ob.metrics.isDueThisMonth
                        ? `${yearMonth}-${String(Math.max(1, Math.min(31, ob.dueDay || 1))).padStart(2, '0')}`
                        : ob.nextDueDate;
                      const paidDate = (ob.occurrence?.bankDate || ob.occurrence?.paidAt || '').slice(0, 10);
                      return (
                        <div
                          key={ob.id}
                          onClick={() =>
                            setDrawer({
                              entityType: 'obligation',
                              entityId: ob.id,
                              workspaceId: ob.workspaceId,
                              title: ob.name,
                              subtitle: `${ob.cadence} · ${t.dueLabel} ${ob.nextDueDate}`,
                              manageUrl: ob.manageUrl,
                              portalUrl: ob.portalUrl,
                              referenceNumber: ob.referenceNumber,
                              notes: ob.notes,
                              currency: ob.currency,
                            })
                          }
                          className={`px-4 py-3 flex items-center justify-between hover:bg-slate-50 cursor-pointer ${
                            ob.isPaidThisMonth ? 'bg-emerald-50/15' : ''
                          }`}
                        >
                          <div className="flex items-start gap-2.5 min-w-0">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleTogglePaid(ob);
                              }}
                              className="mt-0.5 text-slate-400 hover:text-teal-700 shrink-0"
                              title={ob.isPaidThisMonth ? t.markUnpaid : t.markPaid}
                            >
                              {ob.isPaidThisMonth ? (
                                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                              ) : (
                                <Circle className="w-4 h-4 text-amber-600" />
                              )}
                            </button>
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-slate-900">
                                <span className={ob.isPaidThisMonth ? 'line-through text-slate-500' : ''}>
                                  {ob.name}
                                </span>
                                <span
                                  className={`text-[10px] px-1.5 py-0.5 rounded border font-mono-num ${
                                    ob.isPaidThisMonth
                                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200 font-semibold'
                                      : 'bg-amber-50 text-amber-800 border-amber-300 font-semibold'
                                  }`}
                                >
                                  {ob.isPaidThisMonth
                                    ? `✓ Paid${paidDate ? ` ${paidDate}` : ''}`
                                    : ob.metrics.isDueThisMonth
                                      ? `⏳ Planned · Due ${dueIso}`
                                      : `⏳ Preserve · Due ${ob.nextDueDate}`}
                                </span>
                                {ob.manageUrl && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-50 text-teal-800 font-mono-num">
                                    {t.portalLinkBadge}
                                  </span>
                                )}
                              </div>
                              <div className="text-[11px] text-slate-500 font-mono-num mt-0.5">
                                {ob.cadence} · {t.dueLabel} {dueIso}
                                {ob.accountName ? ` · 🏦 ${ob.accountName}` : ''}
                              </div>
                            </div>
                          </div>
                          <div
                            className={`font-mono-num text-xs font-semibold shrink-0 pl-2 ${
                              ob.isPaidThisMonth ? 'text-emerald-800' : 'text-amber-900'
                            }`}
                          >
                            {fmt(ob.effectiveDisplayMinor)}/mo
                          </div>
                        </div>
                      );
                    })}
                </div>
              </section>
            </div>
          </>
        )}

        {/* ======================== TAB 4: WEALTH & BELONGINGS ======================== */}
        {tab === 'wealth' && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <button
                type="button"
                onClick={() => setWealthMode('mine')}
                className={`text-left bg-white border rounded-lg p-4 transition ${
                  wealthMode === 'mine' ? 'border-slate-900 ring-1 ring-slate-900' : 'border-slate-200'
                }`}
              >
                <div className="text-[11px] font-mono-num uppercase tracking-wider text-slate-400">
                  {t.myNetWorthCard(boot.user.displayName)}
                </div>
                <div className="mt-1 text-2xl font-mono-num font-semibold text-slate-900">
                  {formatIndexedWealth(
                    wealth.myWealth.netWorthMinor,
                    wealth.combinedFamilyWealth.netWorthMinor || 1,
                    cur,
                    privacyMode
                  )}
                </div>
                <div className="mt-1 text-xs text-slate-500 font-mono-num">
                  {t.assetsShort} {fmt(wealth.myWealth.totalAssetsMinor, wealth.myWealth.totalAssetsMinor || 1, true)} ·{' '}
                  {t.debtShort} {fmt(wealth.myWealth.totalLiabilitiesMinor, wealth.myWealth.totalAssetsMinor || 1, true)}
                </div>
              </button>

              <div className="bg-white border border-slate-200 rounded-lg p-4">
                <div className="text-[11px] font-mono-num uppercase tracking-wider text-slate-400">
                  {t.partnerWealthCard} ({wealth.partnerWealth.visibility})
                </div>
                <div className="mt-1 text-2xl font-mono-num font-semibold text-slate-800">
                  {wealth.partnerWealth.netWorthMinor != null
                    ? formatIndexedWealth(
                        wealth.partnerWealth.netWorthMinor,
                        wealth.combinedFamilyWealth.netWorthMinor || 1,
                        cur,
                        privacyMode
                      )
                    : t.privateLabel}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {wealth.partnerWealth.visibility === 'private'
                    ? t.visPrivateDesc
                    : wealth.partnerWealth.visibility === 'totals_only'
                    ? t.visTotalsDesc
                    : t.visReadonlyDesc}
                </div>
              </div>

              <button
                type="button"
                onClick={() => setWealthMode('combined')}
                className={`text-left bg-white border rounded-lg p-4 transition ${
                  wealthMode === 'combined' ? 'border-teal-800 ring-1 ring-teal-800' : 'border-slate-200'
                }`}
              >
                <div className="text-[11px] font-mono-num uppercase tracking-wider text-teal-700 font-semibold">
                  {t.combinedWealthCard}
                </div>
                <div className="mt-1 text-2xl font-mono-num font-semibold text-teal-900">
                  {formatIndexedWealth(
                    wealth.combinedFamilyWealth.netWorthMinor,
                    wealth.combinedFamilyWealth.netWorthMinor || 1,
                    cur,
                    privacyMode
                  )}
                </div>
                <div className="mt-1 text-xs text-slate-500 font-mono-num">
                  {t.assetsShort}{' '}
                  {fmt(
                    wealth.combinedFamilyWealth.totalAssetsMinor,
                    wealth.combinedFamilyWealth.totalAssetsMinor || 1,
                    true
                  )}{' '}
                  · {t.debtShort}{' '}
                  {fmt(
                    wealth.combinedFamilyWealth.totalLiabilitiesMinor,
                    wealth.combinedFamilyWealth.totalAssetsMinor || 1,
                    true
                  )}
                </div>
              </button>
            </div>

            <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                    {t.trajectoryTitle(
                      wealthMode === 'combined' ? t.combinedWealthCard : boot.user.displayName,
                      horizonYears
                    )}
                    {wealthPastYears > 0 ? ` · -${wealthPastYears}Y HISTORY` : ''}
                  </h2>
                  <p className="text-xs text-slate-400">{t.trajectorySub}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {/* Past History Lookback (-10Y / -5Y / -3Y / -1Y / 0Y) */}
                  <div className="inline-flex items-center border border-slate-200 bg-[#FAF9F6] rounded-md p-0.5 text-xs font-mono-num">
                    <span className="px-2 text-[10px] uppercase text-slate-400">History</span>
                    {[10, 5, 3, 1, 0].map((pastYr) => (
                      <button
                        key={`past-${pastYr}`}
                        type="button"
                        onClick={() => setWealthPastYears(pastYr)}
                        className={`px-2 py-0.5 rounded transition ${
                          wealthPastYears === pastYr
                            ? 'bg-teal-700 text-white font-semibold'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {pastYr === 0 ? '0Y' : `-${pastYr}Y`}
                      </button>
                    ))}
                  </div>

                  {/* Future Forecast Horizon (0Y / +5Y / +10Y / +20Y) */}
                  <div className="inline-flex items-center border border-slate-200 bg-[#FAF9F6] rounded-md p-0.5 text-xs font-mono-num">
                    <span className="px-2 text-[10px] uppercase text-slate-400">Forecast</span>
                    {[0, 5, 10, 20].map((yr) => (
                      <button
                        key={`fwd-${yr}`}
                        type="button"
                        onClick={() => setHorizonYears(yr)}
                        className={`px-2 py-0.5 rounded transition ${
                          horizonYears === yr
                            ? 'bg-slate-900 text-white font-semibold'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {yr === 0 ? '0Y' : `+${yr}Y`}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <WealthHorizonChart
                history={
                  wealthMode === 'combined'
                    ? wealth.combinedFamilyWealth.history
                    : wealth.myWealth.history || []
                }
                projection={
                  wealthMode === 'combined' ? wealth.combinedFamilyWealth.projection : wealth.myWealth.projection
                }
                currency={cur}
                privacyMode={privacyMode}
                t={t}
              />
            </section>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                  <span className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                    {t.belongingsTitle}
                  </span>
                  <button
                    type="button"
                    onClick={() => setModal({ kind: 'asset' })}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-900 text-white text-xs"
                  >
                    <Plus className="w-3 h-3" /> {t.addItemBtn}
                  </button>
                </div>
                <div className="divide-y divide-slate-100">
                  {wealth.assets.map((ast) => {
                    const ratePct = (ast.annualRateBp / 100).toFixed(1);
                    const appreciating = ast.annualRateBp >= 0;
                    return (
                      <div
                        key={ast.id}
                        onClick={() =>
                          setDrawer({
                            entityType: 'asset',
                            entityId: ast.id,
                            workspaceId: ast.workspaceId,
                            title: ast.name,
                            subtitle: `${ast.assetClass} · ${ratePct}%/yr`,
                            manageUrl: ast.manageUrl,
                            portalUrl: ast.portalUrl,
                            referenceNumber: ast.referenceNumber,
                            notes: ast.notes,
                            currency: ast.currency,
                          })
                        }
                        className="px-4 py-3 flex items-center justify-between hover:bg-slate-50 cursor-pointer"
                      >
                        <div>
                          <div className="text-xs font-medium text-slate-900">{ast.name}</div>
                          <div className="text-[11px] text-slate-500 flex items-center gap-2 font-mono-num">
                            <span className="capitalize">{ast.assetClass}</span>
                            <span
                              className={`inline-flex items-center gap-0.5 ${
                                appreciating ? 'text-emerald-700' : 'text-amber-700'
                              }`}
                            >
                              {appreciating ? (
                                <TrendingUp className="w-3 h-3" />
                              ) : (
                                <TrendingDown className="w-3 h-3" />
                              )}
                              {appreciating ? `+${ratePct}%/yr` : `${ratePct}%/yr`}
                            </span>
                          </div>
                        </div>
                        <div className="text-right font-mono-num text-xs font-semibold text-slate-900">
                          {fmt(ast.displayValueMinor, wealth.combinedFamilyWealth.totalAssetsMinor || 1, true)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <div className="space-y-4">
                <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                    <span className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                      {t.liabilitiesTitle}
                    </span>
                    <button
                      type="button"
                      onClick={() => setModal({ kind: 'liability' })}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 text-xs text-slate-700"
                    >
                      <Plus className="w-3 h-3" /> {t.addLiabilityBtn}
                    </button>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {wealth.liabilities.map((lb) => (
                      <div
                        key={lb.id}
                        onClick={() =>
                          setDrawer({
                            entityType: 'liability',
                            entityId: lb.id,
                            workspaceId: lb.workspaceId,
                            title: lb.name,
                            subtitle: `${lb.kind} · ${(lb.aprBp / 100).toFixed(2)}% APR`,
                            portalUrl: lb.portalUrl,
                            referenceNumber: lb.referenceNumber,
                            notes: lb.notes,
                            currency: lb.currency,
                          })
                        }
                        className="px-4 py-3 flex items-center justify-between hover:bg-slate-50 cursor-pointer"
                      >
                        <div>
                          <div className="text-xs font-medium text-slate-900">{lb.name}</div>
                          <div className="text-[11px] text-slate-500 font-mono-num">
                            {(lb.aprBp / 100).toFixed(2)}% APR ·{' '}
                            {fmt(lb.displayMonthlyMinor, wealth.combinedFamilyWealth.totalAssetsMinor || 1)}/mo
                          </div>
                        </div>
                        <div className="font-mono-num text-xs font-semibold text-rose-700">
                          -{fmt(lb.displayBalanceMinor, wealth.combinedFamilyWealth.totalAssetsMinor || 1, true)}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                    <span className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                      {t.salaryHistoryTitle}
                    </span>
                    <button
                      type="button"
                      onClick={() => setModal({ kind: 'income' })}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 text-xs text-slate-700"
                    >
                      <Plus className="w-3 h-3" /> {t.addIncomeBtn}
                    </button>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {wealth.salaryHistory.map((inc) => (
                      <div
                        key={inc.id}
                        onClick={() => openEntityDrawer('income', inc.id)}
                        className="px-4 py-2.5 flex items-center justify-between text-xs hover:bg-slate-50 cursor-pointer"
                      >
                        <div>
                          <div className="font-medium text-slate-800 inline-flex items-center gap-1.5">
                            <span>{inc.name}</span>
                            <Pencil className="w-3 h-3 text-slate-400" />
                          </div>
                          <div className="text-[11px] text-slate-400 font-mono-num">
                            {inc.effectiveFrom} → {inc.effectiveTo || t.presentLabel} ({inc.paydayDay}.)
                          </div>
                        </div>
                        <div className="font-mono-num font-semibold text-slate-800">
                          {privacyMode
                            ? '•••'
                            : `${CURRENCY_SYMBOLS[inc.currency]}${(inc.amountMinor / 100).toLocaleString('en-GB', {
                                minimumFractionDigits: 2,
                              })}/${inc.cadence === 'annual' ? 'yr' : 'mo'}`}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </div>
          </>
        )}

        {/* ======================== TAB 5: SETTINGS, WORKSPACES, LOCAL USERS & MCP ======================== */}
        {tab === 'settings' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="space-y-5">
              {/* Preferences: Currency, Language (EN/PL), Partner Privacy & FX */}
              <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
                <h2 className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                  {t.prefsSectionTitle}
                </h2>

                <form
                  className="space-y-4"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const fd = new FormData(e.currentTarget);
                    const nextLoc = (fd.get('locale') as LocaleCode) || locale;
                    setLocale(nextLoc);
                    localStorage.setItem('skyday_locale', nextLoc);

                    const fxPayload = boot.fxRates
                      .filter((r) => r.currency !== 'GBP')
                      .map((r) => ({
                        currency: r.currency,
                        rateToGbp: Number(fd.get(`fx_${r.currency}`) || r.rateToGbp),
                      }));

                    await apiFetch('/api/settings/preferences', {
                      method: 'PATCH',
                      body: JSON.stringify({
                        defaultCurrency: fd.get('defaultCurrency'),
                        locale: nextLoc,
                        partnerVisibility: fd.get('partnerVisibility') as PartnerVisibility,
                        sharedSplitMode: fd.get('sharedSplitMode') as SplitMode,
                        fxRates: fxPayload,
                      }),
                    });
                    await reloadAll();
                  }}
                >
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <label className="block text-xs space-y-1">
                      <span className="text-slate-600 font-medium">{t.defaultCurrencyLabel}</span>
                      <select
                        name="defaultCurrency"
                        defaultValue={boot.user.defaultCurrency}
                        className="w-full border border-slate-200 rounded-md px-2.5 py-1.5 font-mono-num"
                      >
                        {(['GBP', 'EUR', 'PLN', 'USD', 'CHF'] as CurrencyCode[]).map((c) => (
                          <option key={c} value={c}>
                            {c} ({CURRENCY_SYMBOLS[c].trim()})
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="block text-xs space-y-1">
                      <span className="text-slate-600 font-medium">{t.languageLabel}</span>
                      <select
                        name="locale"
                        value={locale}
                        onChange={(e) => void switchLocale(e.target.value as LocaleCode)}
                        className="w-full border border-slate-200 rounded-md px-2.5 py-1.5"
                      >
                        <option value="en">English (EN)</option>
                        <option value="pl">Polski (PL)</option>
                      </select>
                    </label>

                    <label className="block text-xs space-y-1">
                      <span className="text-slate-600 font-medium">{t.defaultSplitLabel}</span>
                      <select
                        name="sharedSplitMode"
                        defaultValue={sharedWs?.defaultSplitMode || 'equal_50_50'}
                        className="w-full border border-slate-200 rounded-md px-2.5 py-1.5"
                      >
                        <option value="equal_50_50">{t.splitEqual}</option>
                        <option value="income_proportional">{t.splitProportional}</option>
                        <option value="custom_bp">{t.splitCustom}</option>
                      </select>
                    </label>
                  </div>

                  <label className="block text-xs space-y-1">
                    <span className="text-slate-600 font-medium">
                      {t.privacyScopeLabel} ({boot.user.displayName})
                    </span>
                    <select
                      name="partnerVisibility"
                      defaultValue={myPersonalWs?.partnerVisibility || 'totals_only'}
                      className="w-full border border-slate-200 rounded-md px-2.5 py-1.5"
                    >
                      <option value="private">{t.privStrict}</option>
                      <option value="totals_only">{t.privTotals}</option>
                      <option value="readonly">{t.privReadonly}</option>
                    </select>
                  </label>

                  <div className="pt-2 border-t border-slate-100">
                    <div className="text-xs font-medium text-slate-600 mb-2">{t.fxEstimatesLabel}</div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {boot.fxRates
                        .filter((r) => r.currency !== 'GBP')
                        .map((r) => (
                          <label key={r.currency} className="block text-[11px] font-mono-num space-y-1">
                            <span className="text-slate-500">1 {r.currency} = £</span>
                            <input
                              type="number"
                              step="0.0001"
                              name={`fx_${r.currency}`}
                              defaultValue={r.rateToGbp}
                              className="w-full border border-slate-200 rounded px-2 py-1"
                            />
                          </label>
                        ))}
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="px-3.5 py-1.5 rounded-md bg-slate-900 text-white text-xs font-medium hover:bg-slate-800"
                  >
                    {t.savePrefsBtn}
                  </button>
                </form>
              </section>

              {/* Multi-Workspace Creation & Sharing (Company A, Company B, Household, Family) */}
              <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
                <div>
                  <h2 className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold flex items-center gap-1.5">
                    <Building2 className="w-3.5 h-3.5 text-teal-700" /> {t.workspacesSectionTitle}
                  </h2>
                  <p className="text-[11px] text-slate-400 mt-0.5">{t.workspacesSectionSub}</p>
                </div>

                <form
                  className="flex flex-wrap items-center gap-2 text-xs"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const fd = new FormData(e.currentTarget);
                    const name = String(fd.get('name') || '').trim();
                    const kind = (fd.get('kind') as WorkspaceKind) || 'company';
                    if (!name) return;
                    const res = await apiFetch<{ workspace: { id: string } }>('/api/workspaces', {
                      method: 'POST',
                      body: JSON.stringify({ name, kind }),
                    });
                    e.currentTarget.reset();
                    await reloadAll();
                    setScope(res.workspace.id);
                  }}
                >
                  <input
                    required
                    name="name"
                    placeholder={t.wsNamePlaceholder}
                    className="flex-1 min-w-[160px] border border-slate-200 rounded px-2.5 py-1.5"
                  />
                  <select name="kind" defaultValue="company" className="border border-slate-200 rounded px-2 py-1.5">
                    <option value="company">{t.wsKindCompany}</option>
                    <option value="shared">{t.wsKindShared}</option>
                    <option value="personal">{t.wsKindPersonal}</option>
                  </select>
                  <button
                    type="submit"
                    className="px-3 py-1.5 rounded bg-slate-900 text-white font-medium hover:bg-slate-800"
                  >
                    + {t.createWorkspaceBtn}
                  </button>
                </form>

                <div className="divide-y divide-slate-100">
                  {boot.workspaces.map((ws) => (
                    <div key={ws.id} className="py-3 space-y-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-800">{ws.name}</span>
                          <span className="text-[10px] font-mono-num px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 uppercase">
                            {ws.kind}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setScope(ws.id);
                              setTab('overview');
                            }}
                            className="px-2 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50 text-[11px]"
                          >
                            {t.openWorkspaceBtn}
                          </button>
                          {ws.canManage && (
                            <button
                              type="button"
                              onClick={async () => {
                                const nextName = prompt(t.renameWorkspacePrompt(ws.name), ws.name)?.trim();
                                if (!nextName || nextName === ws.name) return;
                                await apiFetch(`/api/workspaces/${ws.id}`, {
                                  method: 'PATCH',
                                  body: JSON.stringify({ name: nextName }),
                                });
                                await reloadAll();
                              }}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-900 hover:text-white text-[11px] transition"
                            >
                              <Pencil className="w-3 h-3" /> {t.editBtn}
                            </button>
                          )}
                          {ws.canManage &&
                            ws.id !== 'ws-home' &&
                            ws.id !== 'ws-wadera' &&
                            ws.id !== 'ws-walter' &&
                            ws.id !== boot.user.personalWorkspaceId && (
                              <button
                                type="button"
                                onClick={async () => {
                                  if (!confirm(t.deleteWsConfirm(ws.name))) return;
                                  await apiFetch(`/api/workspaces/${ws.id}`, { method: 'DELETE' });
                                  if (scope === ws.id) setScope('all');
                                  await reloadAll();
                                }}
                                className="text-rose-600 hover:underline text-[11px]"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                        </div>
                      </div>

                      {/* Members & Sharing Controls */}
                      <div className="flex flex-wrap items-center gap-1.5">
                        {ws.members.map((m) => (
                          <span
                            key={m.userId}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-[11px] text-slate-700"
                          >
                            <span>{m.displayName}</span>
                            <span className="font-mono-num text-[10px] text-slate-400">({m.role})</span>
                            {ws.canManage && m.userId !== ws.ownerUserId && (
                              <button
                                type="button"
                                onClick={async () => {
                                  await apiFetch(`/api/workspaces/${ws.id}/members/${m.userId}`, {
                                    method: 'DELETE',
                                  });
                                  await reloadAll();
                                }}
                                className="text-slate-400 hover:text-rose-600 ml-0.5"
                              >
                                ×
                              </button>
                            )}
                          </span>
                        ))}
                      </div>

                      {ws.canManage && boot.users.length > 1 && (
                        <form
                          className="flex flex-wrap items-center gap-1.5 pt-1"
                          onSubmit={async (e) => {
                            e.preventDefault();
                            const fd = new FormData(e.currentTarget);
                            const targetUserId = String(fd.get('userId') || '');
                            const role = (fd.get('role') as WorkspaceRole) || 'editor';
                            if (!targetUserId) return;
                            await apiFetch(`/api/workspaces/${ws.id}/members`, {
                              method: 'POST',
                              body: JSON.stringify({ userId: targetUserId, role }),
                            });
                            await reloadAll();
                          }}
                        >
                          <select
                            name="userId"
                            defaultValue=""
                            className="border border-slate-200 rounded px-2 py-1 text-[11px]"
                          >
                            <option value="" disabled>
                              {t.shareWithUserPlaceholder}
                            </option>
                            {boot.users
                              .filter((u) => u.id !== ws.ownerUserId)
                              .map((u) => (
                                <option key={u.id} value={u.id}>
                                  {u.displayName} (@{u.handle})
                                </option>
                              ))}
                          </select>
                          <select
                            name="role"
                            defaultValue="editor"
                            className="border border-slate-200 rounded px-2 py-1 text-[11px]"
                          >
                            <option value="editor">{t.roleEditor}</option>
                            <option value="viewer">{t.roleViewer}</option>
                            <option value="totals_only">{t.roleTotals}</option>
                          </select>
                          <button
                            type="submit"
                            className="px-2 py-1 rounded bg-teal-700 text-white text-[11px] font-medium hover:bg-teal-800"
                          >
                            {t.shareBtn}
                          </button>
                        </form>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            </div>

            <div className="space-y-5">
              {/* Users, Local Accounts (Brother / Friends outside Authentik SSO) & Password */}
              <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
                <div>
                  <h2 className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5 text-teal-700" /> {t.usersSectionTitle}
                  </h2>
                  <p className="text-[11px] text-slate-400 mt-0.5">{t.usersSectionSub}</p>
                </div>

                {inviteBanner && (
                  <div className="p-2.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center justify-between">
                    <span>{inviteBanner}</span>
                    <button type="button" onClick={() => setInviteBanner(null)}>
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                {boot.user.isAdmin && (
                  <form
                    className="space-y-2.5 text-xs bg-[#FAF9F6] border border-slate-200 rounded-lg p-3.5"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const formEl = e.currentTarget;
                      const fd = new FormData(formEl);
                      const handle = String(fd.get('handle') || '').trim();
                      const displayName = String(fd.get('displayName') || '').trim();
                      const email = String(fd.get('email') || '').trim();
                      const password = String(fd.get('password') || '');
                      const userLocale = (fd.get('locale') as LocaleCode) || locale;
                      const defaultCurrency = (fd.get('defaultCurrency') as CurrencyCode) || cur;
                      const shareWsId = String(fd.get('shareWsId') || '');

                      const sharedWorkspaceGrants = shareWsId
                        ? [{ workspaceId: shareWsId, role: 'editor' as WorkspaceRole }]
                        : [];

                      const res = await apiFetch<{ user: { handle: string; displayName: string } }>('/api/users/local', {
                        method: 'POST',
                        body: JSON.stringify({
                          handle,
                          displayName,
                          email: email || undefined,
                          password,
                          locale: userLocale,
                          defaultCurrency,
                          sharedWorkspaceGrants,
                        }),
                      });

                      const inviteText =
                        userLocale === 'pl'
                          ? `Zaproszenie do Skyday Finance (${window.location.origin}):\nLogin: ${res.user.handle}\nHasło: ${password}\n(Wybierz "lub zaloguj się kontem lokalnym")`
                          : `Skyday Finance Invite (${window.location.origin}):\nUsername: ${res.user.handle}\nPassword: ${password}\n(Use "sign in with local account")`;
                      await navigator.clipboard.writeText(inviteText).catch(() => {});
                      setInviteBanner(t.inviteCopiedBanner);
                      formEl.reset();
                      await reloadAll();
                    }}
                  >
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <input
                        required
                        name="handle"
                        placeholder={t.localHandlePlaceholder}
                        className="border border-slate-200 bg-white rounded px-2.5 py-1.5"
                      />
                      <input
                        required
                        name="displayName"
                        placeholder={t.localDisplayPlaceholder}
                        className="border border-slate-200 bg-white rounded px-2.5 py-1.5"
                      />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <input
                        required
                        type="password"
                        minLength={6}
                        name="password"
                        placeholder={t.localPasswordPlaceholder}
                        className="border border-slate-200 bg-white rounded px-2.5 py-1.5"
                      />
                      <select name="locale" defaultValue={locale} className="border border-slate-200 bg-white rounded px-2 py-1.5">
                        <option value="en">English (EN)</option>
                        <option value="pl">Polski (PL)</option>
                      </select>
                      <select
                        name="defaultCurrency"
                        defaultValue={cur}
                        className="border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                      >
                        {(['GBP', 'PLN', 'EUR', 'USD', 'CHF'] as CurrencyCode[]).map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <select
                        name="shareWsId"
                        defaultValue=""
                        className="border border-slate-200 bg-white rounded px-2 py-1.5 text-[11px]"
                      >
                        <option value="">{t.noInitialShare}</option>
                        {boot.workspaces
                          .filter((w) => w.canManage)
                          .map((w) => (
                            <option key={w.id} value={w.id}>
                              + {w.name}
                            </option>
                          ))}
                      </select>
                      <button
                        type="submit"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-teal-700 text-white font-medium hover:bg-teal-800"
                      >
                        <UserPlus className="w-3.5 h-3.5" /> {t.createLocalUserBtn}
                      </button>
                    </div>
                  </form>
                )}

                <div className="divide-y divide-slate-100">
                  {boot.users.map((u) => (
                    <div key={u.id} className="py-2 flex items-center justify-between text-xs">
                      <div>
                        <span className="font-medium text-slate-800">{u.displayName}</span>{' '}
                        <span className="font-mono-num text-slate-400">@{u.handle}</span>{' '}
                        <span className="text-[10px] font-mono-num px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 uppercase">
                          {u.authProvider} · {u.locale}
                        </span>
                      </div>
                      {boot.user.isAdmin && (
                        <button
                          type="button"
                          onClick={async () => {
                            const nextPwd = prompt(t.resetPwdPrompt(u.displayName));
                            if (!nextPwd || nextPwd.length < 6) return;
                            await apiFetch(`/api/users/${u.id}`, {
                              method: 'PATCH',
                              body: JSON.stringify({ password: nextPwd }),
                            });
                            setInviteBanner(t.passwordUpdatedMsg);
                          }}
                          className="text-[11px] text-teal-700 hover:underline"
                        >
                          {t.resetPwdBtn}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              {/* Bank Accounts */}
              <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold flex items-center gap-1.5">
                    <Landmark className="w-3.5 h-3.5" /> {t.bankAccountsTitle}
                  </h2>
                  <button
                    type="button"
                    onClick={() => setModal({ kind: 'account' })}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 text-xs"
                  >
                    <Plus className="w-3 h-3" /> {t.addAccountBtn}
                  </button>
                </div>
                <div className="divide-y divide-slate-100">
                  {allAvailableAccounts.map((acc) => (
                    <div
                      key={acc.id}
                      onClick={() => openEntityDrawer('account', acc.id)}
                      className="py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs hover:bg-slate-50 cursor-pointer px-2 rounded"
                    >
                      <div className="inline-flex items-center gap-1.5 min-w-0">
                        <span className="font-medium text-slate-800">{acc.name}</span>{' '}
                        <span className="text-slate-400">({acc.institution})</span>
                      </div>
                      <div className="flex items-center gap-2.5 font-mono-num">
                        <span className="font-semibold text-slate-900">
                          {formatDisplayValue(acc.balanceMinor, { currency: acc.currency, privacyMode })}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openEntityDrawer('account', acc.id);
                          }}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-300 bg-white text-[11px] font-sans font-medium text-slate-700 hover:bg-slate-900 hover:text-white hover:border-slate-900 transition"
                        >
                          <Pencil className="w-3 h-3" /> {t.editAccountBtn}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {/* MCP Connector */}
              <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
                <div className="space-y-2.5">
                  <div>
                    <h2 className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-teal-700" /> {t.mcpSectionTitle}
                    </h2>
                    <p className="text-[11px] text-slate-400">{t.mcpSectionSub}</p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={agentKeyLabel}
                      onChange={(e) => setAgentKeyLabel(e.target.value)}
                      placeholder={`${boot.user.displayName} MCP Agent`}
                      className="flex-1 min-w-[140px] border border-slate-200 rounded px-2.5 py-1.5 text-xs"
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        const label = agentKeyLabel.trim() || `${boot.user.displayName} MCP Agent`;
                        const res = await apiFetch<{ rawToken: string }>('/api/settings/api-keys', {
                          method: 'POST',
                          body: JSON.stringify({ label }),
                        });
                        setNewlyMintedKey(res.rawToken);
                        setAgentKeyLabel('');
                        const promptText = buildAgentBootstrapPrompt({
                          origin: window.location.origin,
                          displayName: boot.user.displayName,
                          personalWorkspaceId: boot.user.personalWorkspaceId,
                          defaultCurrency: boot.user.defaultCurrency,
                          token: res.rawToken,
                        });
                        await navigator.clipboard.writeText(promptText).catch(() => {});
                        setCopiedNotice('Minted & copied full Agent Bootstrap Prompt to clipboard!');
                        setTimeout(() => setCopiedNotice(null), 4000);
                        await reloadAll();
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 transition"
                    >
                      <Copy className="w-3.5 h-3.5 text-teal-400" /> {t.mintAndCopyBtn}
                    </button>
                  </div>
                </div>

                {copiedNotice && (
                  <div className="px-3 py-2 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-1.5 font-medium">
                    <Check className="w-3.5 h-3.5 shrink-0" />
                    <span>{copiedNotice}</span>
                  </div>
                )}

                {newlyMintedKey && (
                  <div className="p-3 rounded-lg bg-amber-50/80 border border-amber-200 text-xs space-y-2">
                    <div className="font-mono-num text-[11px] bg-white border border-amber-200 rounded px-2.5 py-1.5 break-all select-all text-slate-800">
                      {newlyMintedKey}
                    </div>
                  </div>
                )}

                <div className="divide-y divide-slate-100">
                  {boot.apiKeys.map((k) => (
                    <div key={k.id} className="py-1.5 flex items-center justify-between text-xs font-mono-num">
                      <span>
                        {k.label} ({k.keyPrefix}…)
                      </span>
                      <button
                        type="button"
                        onClick={async () => {
                          await apiFetch(`/api/settings/api-keys/${k.id}`, { method: 'DELETE' });
                          await reloadAll();
                        }}
                        className="text-rose-600 hover:underline"
                      >
                        {t.revokeBtn}
                      </button>
                    </div>
                  ))}
                </div>
              </section>

              {/* Persistent Storage Backup & Starter Data Controls */}
              <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
                <h2 className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                  {t.storageSectionTitle}
                </h2>
                <div className="flex flex-wrap gap-2">
                  <a
                    href="/api/settings/backup"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Download className="w-3.5 h-3.5" /> {t.downloadBackupBtn}
                  </a>
                  <button
                    type="button"
                    onClick={async () => {
                      await apiFetch('/api/settings/sample-data', {
                        method: 'POST',
                        body: JSON.stringify({ action: 'load' }),
                      });
                      await reloadAll();
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-200 text-xs text-slate-600 hover:bg-slate-50"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> {t.resetDemoBtn}
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!confirm('Clear all financial entries?')) return;
                      await apiFetch('/api/settings/sample-data', {
                        method: 'POST',
                        body: JSON.stringify({ action: 'clear' }),
                      });
                      await reloadAll();
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-rose-200 text-xs text-rose-700 hover:bg-rose-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> {t.clearAllBtn}
                  </button>
                </div>
              </section>
            </div>
          </div>
        )}
      </main>

      {/* ======================== UNIVERSAL EDIT, LINKS & DOCUMENT VAULT DRAWER ======================== */}
      {drawer && (
        <div className="fixed inset-0 z-40 bg-slate-900/30 flex justify-end" onClick={() => setDrawer(null)}>
          <div
            className="w-full max-w-md bg-white h-full border-l border-slate-200 p-6 overflow-y-auto space-y-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-[10px] font-mono-num uppercase tracking-wider text-teal-700">
                  {drawer.entityType} {t.detailsSuffix}
                </div>
                <h3 className="text-lg font-semibold text-slate-900">{drawer.title}</h3>
                <p className="text-xs text-slate-500 font-mono-num">{drawer.subtitle}</p>
              </div>
              <button type="button" onClick={() => setDrawer(null)} className="p-1 text-slate-400 hover:text-slate-700">
                <X className="w-4 h-4" />
              </button>
            </div>

            {drawerSavedMsg && (
              <div className="px-3 py-2 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-1.5 font-medium">
                <Check className="w-3.5 h-3.5 shrink-0" />
                <span>{drawerSavedMsg}</span>
              </div>
            )}

            {(drawer.manageUrl || drawer.portalUrl || drawer.referenceNumber) && (
              <div className="p-3.5 rounded-lg bg-[#FAF9F6] border border-slate-200 space-y-2">
                <div className="text-[11px] font-mono-num uppercase text-slate-500 font-semibold">
                  {t.actionableLinksTitle}
                </div>
                {drawer.manageUrl && (
                  <a
                    href={drawer.manageUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-between text-xs font-medium text-teal-800 hover:underline"
                  >
                    <span>{t.managePortalLink}</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
                {drawer.portalUrl && drawer.portalUrl !== drawer.manageUrl && (
                  <a
                    href={drawer.portalUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-between text-xs font-medium text-slate-700 hover:underline"
                  >
                    <span>{t.providerLoginLink}</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
                {drawer.referenceNumber && (
                  <div className="text-xs font-mono-num text-slate-600">
                    {t.refPolicyLabel} <span className="font-semibold">{drawer.referenceNumber}</span>
                  </div>
                )}
              </div>
            )}

            {/* INLINE UNIVERSAL EDIT FORM FOR ALL ENTITY TYPES */}
            {(() => {
              if (drawer.entityType === 'obligation') {
                const ob = (budget.allObligations || budget.obligations).find((o) => o.id === drawer.entityId);
                if (!ob) return null;
                const occDateTimeDefault =
                  ob.isPaidThisMonth && ob.occurrence?.paidAt && ob.occurrence.paidAt.length >= 16
                    ? ob.occurrence.paidAt.slice(0, 16)
                    : `${yearMonth}-${String(ob.dueDay || 1).padStart(2, '0')}T09:00`;

                return (
                  <form
                    key={`edit-ob-${ob.id}`}
                    className="p-3.5 rounded-lg border border-slate-200 bg-[#FAF9F6]/60 space-y-2.5 text-xs"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const fd = new FormData(e.currentTarget);
                      const nextName = String(fd.get('name') || ob.name).trim();
                      const nextManageUrl = String(fd.get('manageUrl') || '').trim() || null;
                      const nextPortalUrl = String(fd.get('portalUrl') || '').trim() || null;
                      const nextRef = String(fd.get('referenceNumber') || '').trim() || null;
                      const nextNotes = String(fd.get('notes') || '').trim() || null;
                      const occDt = String(fd.get('occurrencePaidAt') || '').trim();

                      await apiFetch('/api/obligations', {
                        method: 'POST',
                        body: JSON.stringify({
                          id: ob.id,
                          workspaceId: fd.get('workspaceId') || ob.workspaceId,
                          potId: fd.get('potId') || null,
                          accountId: fd.get('accountId') || null,
                          preserveAccountId: fd.get('preserveAccountId') || null,
                          liabilityId: fd.get('liabilityId') || null,
                          name: nextName,
                          amountMinor: Math.round(Number(fd.get('amountMajor') || 0) * 100),
                          currency: fd.get('currency') || ob.currency,
                          cadence: fd.get('cadence') || ob.cadence,
                          intervalMonths: ob.intervalMonths,
                          nextDueDate: fd.get('nextDueDate') || ob.nextDueDate,
                          preservedMinor: Math.round(Number(fd.get('preservedMajor') || 0) * 100),
                          autoPreserve: fd.get('autoPreserve') === 'on',
                          splitMode: ob.splitMode,
                          waderaSplitBp: ob.waderaSplitBp,
                          manageUrl: nextManageUrl,
                          portalUrl: nextPortalUrl,
                          referenceNumber: nextRef,
                          notes: nextNotes,
                          endDate: String(fd.get('endDate') || '').trim() || null,
                          finalAmountMinor:
                            fd.get('finalAmountMajor') && String(fd.get('finalAmountMajor')).trim() !== ''
                              ? Math.round(Number(fd.get('finalAmountMajor')) * 100)
                              : null,
                          isActive: true,
                          ...(ob.isPaidThisMonth && occDt
                            ? {
                                occurrenceYearMonth: yearMonth,
                                occurrencePaidAt: occDt.length === 16 ? `${occDt}:00Z` : occDt,
                              }
                            : {}),
                        }),
                      });
                      setDrawer((prev) =>
                        prev
                          ? {
                              ...prev,
                              title: nextName,
                              manageUrl: nextManageUrl,
                              portalUrl: nextPortalUrl,
                              referenceNumber: nextRef,
                              notes: nextNotes,
                            }
                          : null
                      );
                      setDrawerSavedMsg(t.savedNotice);
                      setTimeout(() => setDrawerSavedMsg(null), 3000);
                      await reloadAll();
                    }}
                  >
                    <div className="text-[11px] font-mono-num uppercase text-slate-600 font-semibold flex items-center gap-1.5">
                      <Pencil className="w-3 h-3 text-teal-700" /> {t.editDetailsTitle}
                    </div>
                    <label className="block space-y-1">
                      <span className="text-slate-600">{t.renameLabel}</span>
                      <input
                        required
                        name="name"
                        defaultValue={ob.name}
                        className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5"
                      />
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="text-slate-600">Workspace</span>
                        <select
                          name="workspaceId"
                          defaultValue={ob.workspaceId}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                        >
                          {writableWorkspaces.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">{t.colPot}</span>
                        <select
                          name="potId"
                          defaultValue={ob.potId || ''}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                        >
                          <option value="">— Unassigned —</option>
                          {budget.pots.map((p) => (
                            <option key={p.id} value={p.id}>
                              {potBreadcrumbs.get(p.id)?.pathString || p.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="grid grid-cols-1 gap-2">
                      <label className="block space-y-1">
                        <span className="text-slate-600">{t.paidFromAccountLabel}</span>
                        <select
                          name="accountId"
                          defaultValue={ob.accountId || ''}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                        >
                          <option value="">{t.noAccountLinkOption}</option>
                          {allAvailableAccounts.map((acc) => (
                            <option key={acc.id} value={acc.id}>
                              🏦 {acc.name} ({acc.institution} · {formatDisplayValue(acc.balanceMinor, { currency: acc.currency, privacyMode })})
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block space-y-1">
                        <span className="text-teal-900 font-medium">🔒 Sinking Reserve ("Preserve") Held on Account</span>
                        <select
                          name="preserveAccountId"
                          defaultValue={ob.preserveAccountId || ''}
                          className="w-full border border-teal-300 bg-white rounded px-2 py-1.5"
                        >
                          <option value="">— Default (Saver / Same as Payment Account) —</option>
                          {allAvailableAccounts.map((acc) => (
                            <option key={acc.id} value={acc.id}>
                              🏦 {acc.name} ({acc.institution} · {formatDisplayValue(acc.balanceMinor, { currency: acc.currency, privacyMode })})
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block space-y-1">
                        <span className="text-slate-600">{t.linkedLiabilityLabel}</span>
                        <select
                          name="liabilityId"
                          defaultValue={ob.liabilityId || ''}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                        >
                          <option value="">{t.noLiabilityLinkOption}</option>
                          {allAvailableLiabilities.map((lb) => (
                            <option key={lb.id} value={lb.id}>
                              🏠 {lb.name} ({formatDisplayValue(lb.balanceMinor, { currency: lb.currency, privacyMode })} · {(lb.aprBp / 100).toFixed(2)}% APR)
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <label className="space-y-1">
                        <span className="text-slate-600">{t.amountValueLabel}</span>
                        <input
                          required
                          type="number"
                          step="0.01"
                          name="amountMajor"
                          defaultValue={(ob.amountMinor / 100).toFixed(2)}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">Currency</span>
                        <select
                          name="currency"
                          defaultValue={ob.currency}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        >
                          {(['GBP', 'EUR', 'PLN', 'USD', 'CHF'] as CurrencyCode[]).map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">Cadence</span>
                        <select
                          name="cadence"
                          defaultValue={ob.cadence}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                        >
                          <option value="monthly">Monthly</option>
                          <option value="annual">Yearly (12m)</option>
                          <option value="quarterly">Quarterly (3m)</option>
                          <option value="biannual">Every 6m</option>
                          <option value="once">One-Time</option>
                        </select>
                      </label>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="text-slate-600">Next Due Date</span>
                        <input
                          required
                          type="date"
                          name="nextDueDate"
                          defaultValue={ob.nextDueDate}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">{t.sinkingSavedLabel}</span>
                        <input
                          type="number"
                          step="0.01"
                          name="preservedMajor"
                          defaultValue={(ob.preservedMinor / 100).toFixed(2)}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="text-slate-600">Final / End Date (optional)</span>
                        <input
                          type="date"
                          name="endDate"
                          defaultValue={ob.endDate || ''}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">Final Payment Amount (optional)</span>
                        <input
                          type="number"
                          step="0.01"
                          name="finalAmountMajor"
                          defaultValue={ob.finalAmountMinor != null ? (ob.finalAmountMinor / 100).toFixed(2) : ''}
                          placeholder="e.g. 75.25"
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                    </div>
                    {ob.isPaidThisMonth && (
                      <label className="block space-y-1">
                        <span className="text-emerald-800 font-medium">{t.completedTimestampLabel}</span>
                        <input
                          type="datetime-local"
                          name="occurrencePaidAt"
                          defaultValue={occDateTimeDefault}
                          className="w-full border border-emerald-300 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                    )}
                    <label className="flex items-center gap-2">
                      <input type="checkbox" name="autoPreserve" defaultChecked={ob.autoPreserve} />
                      <span className="text-slate-600">{t.sinkingBadge}</span>
                    </label>
                    <label className="block space-y-1">
                      <span className="text-slate-600">{t.manageUrlLabel}</span>
                      <input
                        type="url"
                        name="manageUrl"
                        defaultValue={ob.manageUrl || ''}
                        placeholder="https://..."
                        className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5"
                      />
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="text-slate-600">{t.portalUrlLabel}</span>
                        <input
                          type="url"
                          name="portalUrl"
                          defaultValue={ob.portalUrl || ''}
                          placeholder="https://..."
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">{t.refPolicyInputLabel}</span>
                        <input
                          name="referenceNumber"
                          defaultValue={ob.referenceNumber || ''}
                          placeholder="POL-12345"
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                    </div>
                    <label className="block space-y-1">
                      <span className="text-slate-600">{t.notesInputLabel}</span>
                      <input
                        name="notes"
                        defaultValue={ob.notes || ''}
                        className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5"
                      />
                    </label>
                    <button
                      type="submit"
                      className="w-full py-2 rounded bg-slate-900 text-white font-medium hover:bg-slate-800 transition"
                    >
                      {t.saveChangesBtn}
                    </button>
                  </form>
                );
              }

              if (drawer.entityType === 'expense') {
                const exp = (budget.allExpenses || budget.expenses).find((e) => e.id === drawer.entityId);
                if (!exp) return null;
                const defaultTime =
                  exp.createdAt && exp.createdAt.length >= 16 && /^\d{2}:\d{2}/.test(exp.createdAt.slice(11, 16))
                    ? exp.createdAt.slice(11, 16)
                    : '12:00';

                return (
                  <form
                    key={`edit-exp-${exp.id}`}
                    className="p-3.5 rounded-lg border border-slate-200 bg-[#FAF9F6]/60 space-y-2.5 text-xs"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const fd = new FormData(e.currentTarget);
                      const nextMerchant = String(fd.get('merchant') || exp.merchant).trim();
                      const nextDesc = String(fd.get('description') || '').trim();
                      const nextDate = String(fd.get('spentDate') || exp.spentDate);
                      const nextTime = String(fd.get('spentTime') || defaultTime);
                      const nextPortal = String(fd.get('portalUrl') || '').trim() || null;

                      await apiFetch('/api/expenses', {
                        method: 'POST',
                        body: JSON.stringify({
                          id: exp.id,
                          workspaceId: fd.get('workspaceId') || exp.workspaceId,
                          potId: fd.get('potId') || null,
                          accountId: fd.get('accountId') || null,
                          liabilityId: fd.get('liabilityId') || null,
                          flowDirection: fd.get('flowDirection') || 'outflow',
                          status: (fd.get('status') || exp.status || 'posted') as TransactionStatus,
                          merchant: nextMerchant,
                          description: nextDesc,
                          amountMinor: Math.round(Number(fd.get('amountMajor') || 0) * 100),
                          currency: fd.get('currency') || exp.currency,
                          spentDate: nextDate,
                          spentTime: nextTime,
                          portalUrl: nextPortal,
                          source: exp.source,
                          items: exp.items,
                        }),
                      });
                      setDrawer((prev) =>
                        prev
                          ? {
                              ...prev,
                              title: nextMerchant,
                              subtitle: `${nextDate} ${nextTime}${nextDesc ? ` · ${nextDesc}` : ''}`,
                              portalUrl: nextPortal,
                            }
                          : null
                      );
                      setDrawerSavedMsg(t.savedNotice);
                      setTimeout(() => setDrawerSavedMsg(null), 3000);
                      await reloadAll();
                    }}
                  >
                    <div className="text-[11px] font-mono-num uppercase text-slate-600 font-semibold flex items-center gap-1.5">
                      <Pencil className="w-3 h-3 text-teal-700" /> {t.editDetailsTitle}
                    </div>
                    <label className="block space-y-1">
                      <span className="text-slate-600">{t.renameLabel}</span>
                      <input
                        required
                        name="merchant"
                        defaultValue={exp.merchant}
                        className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5"
                      />
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="text-slate-600">Workspace</span>
                        <select
                          name="workspaceId"
                          defaultValue={exp.workspaceId}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                        >
                          {writableWorkspaces.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">{t.colPot}</span>
                        <select
                          name="potId"
                          defaultValue={exp.potId || ''}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                        >
                          <option value="">— Unassigned —</option>
                          {budget.pots.map((p) => (
                            <option key={p.id} value={p.id}>
                              {potBreadcrumbs.get(p.id)?.pathString || p.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="text-slate-600">{t.bankAccountLabel}</span>
                        <select
                          name="accountId"
                          defaultValue={exp.accountId || ''}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                        >
                          <option value="">{t.noAccountLinkOption}</option>
                          {allAvailableAccounts.map((acc) => (
                            <option key={acc.id} value={acc.id}>
                              🏦 {acc.name} ({formatDisplayValue(acc.balanceMinor, { currency: acc.currency, privacyMode })})
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">{t.flowDirectionLabel}</span>
                        <select
                          name="flowDirection"
                          defaultValue={exp.flowDirection || 'outflow'}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                        >
                          <option value="outflow">{t.flowOutflowOption}</option>
                          <option value="inflow">{t.flowInflowOption}</option>
                        </select>
                      </label>
                    </div>
                    <label className="block space-y-1">
                      <span className="text-slate-600">{t.txStatusLabel}</span>
                      <select
                        name="status"
                        defaultValue={exp.status || 'posted'}
                        className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                      >
                        <option value="posted">{t.txStatusPosted}</option>
                        <option value="pending">{t.txStatusPending}</option>
                        <option value="reversed">{t.txStatusReversed}</option>
                        <option value="refunded">{t.txStatusRefunded}</option>
                      </select>
                    </label>
                    <label className="block space-y-1">
                      <span className="text-slate-600">{t.linkedLiabilityLabel}</span>
                      <select
                        name="liabilityId"
                        defaultValue={exp.liabilityId || ''}
                        className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                      >
                        <option value="">{t.noLiabilityLinkOption}</option>
                        {allAvailableLiabilities.map((lb) => (
                          <option key={lb.id} value={lb.id}>
                            🏠 {lb.name} ({formatDisplayValue(lb.balanceMinor, { currency: lb.currency, privacyMode })})
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="text-slate-600">{t.amountValueLabel}</span>
                        <input
                          required
                          type="number"
                          step="0.01"
                          name="amountMajor"
                          defaultValue={(exp.amountMinor / 100).toFixed(2)}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">Currency</span>
                        <select
                          name="currency"
                          defaultValue={exp.currency}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        >
                          {(['GBP', 'EUR', 'PLN', 'USD', 'CHF'] as CurrencyCode[]).map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="text-slate-600">Date</span>
                        <input
                          required
                          type="date"
                          name="spentDate"
                          defaultValue={exp.spentDate}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">Time (HH:mm)</span>
                        <input
                          type="time"
                          name="spentTime"
                          defaultValue={defaultTime}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                    </div>
                    <label className="block space-y-1">
                      <span className="text-slate-600">{t.notesInputLabel}</span>
                      <input
                        name="description"
                        defaultValue={exp.description || ''}
                        className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5"
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-slate-600">{t.portalUrlLabel}</span>
                      <input
                        type="url"
                        name="portalUrl"
                        defaultValue={exp.portalUrl || ''}
                        placeholder="https://..."
                        className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5"
                      />
                    </label>
                    <button
                      type="submit"
                      className="w-full py-2 rounded bg-slate-900 text-white font-medium hover:bg-slate-800 transition"
                    >
                      {t.saveChangesBtn}
                    </button>
                  </form>
                );
              }

              if (drawer.entityType === 'pot') {
                const pot = budget.pots.find((p) => p.id === drawer.entityId);
                if (!pot) return null;
                const ownSubtree = collectSubtreePotIds(pot.id, budget.pots);

                return (
                  <form
                    key={`edit-pot-${pot.id}`}
                    className="p-3.5 rounded-lg border border-slate-200 bg-[#FAF9F6]/60 space-y-2.5 text-xs"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const fd = new FormData(e.currentTarget);
                      const nextName = String(fd.get('name') || pot.name).trim();
                      const estMajor = Number(fd.get('monthlyEstimateMajor') || 0);

                      await apiFetch('/api/pots', {
                        method: 'POST',
                        body: JSON.stringify({
                          id: pot.id,
                          workspaceId: fd.get('workspaceId') || pot.workspaceId,
                          parentId: fd.get('parentId') || null,
                          name: nextName,
                          color: fd.get('color') || pot.color,
                          envelopeMode: estMajor > 0,
                          monthlyEstimateMinor: Math.round(estMajor * 100),
                          currency: fd.get('currency') || pot.currency,
                          sortOrder: pot.sortOrder,
                        }),
                      });
                      setDrawer((prev) => (prev ? { ...prev, title: nextName } : null));
                      setDrawerSavedMsg(t.savedNotice);
                      setTimeout(() => setDrawerSavedMsg(null), 3000);
                      await reloadAll();
                    }}
                  >
                    <div className="text-[11px] font-mono-num uppercase text-slate-600 font-semibold flex items-center gap-1.5">
                      <Pencil className="w-3 h-3 text-teal-700" /> {t.editDetailsTitle}
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <label className="col-span-2 space-y-1">
                        <span className="text-slate-600">{t.renameLabel}</span>
                        <input
                          required
                          name="name"
                          defaultValue={pot.name}
                          className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">Color</span>
                        <input
                          type="color"
                          name="color"
                          defaultValue={pot.color || '#2E6F7E'}
                          className="w-full h-8 border border-slate-200 bg-white rounded"
                        />
                      </label>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="text-slate-600">Workspace</span>
                        <select
                          name="workspaceId"
                          defaultValue={pot.workspaceId}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                        >
                          {writableWorkspaces.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">Parent Pot</span>
                        <select
                          name="parentId"
                          defaultValue={pot.parentId || ''}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                        >
                          <option value="">— Top-Level Pot —</option>
                          {budget.pots
                            .filter((p) => !ownSubtree.has(p.id))
                            .map((p) => (
                              <option key={p.id} value={p.id}>
                                {potBreadcrumbs.get(p.id)?.pathString || p.name}
                              </option>
                            ))}
                        </select>
                      </label>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="text-slate-600">Rough Envelope (0 = container)</span>
                        <input
                          type="number"
                          step="0.01"
                          name="monthlyEstimateMajor"
                          defaultValue={(pot.monthlyEstimateMinor / 100).toFixed(2)}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">Currency</span>
                        <select
                          name="currency"
                          defaultValue={pot.currency}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        >
                          {(['GBP', 'EUR', 'PLN', 'USD', 'CHF'] as CurrencyCode[]).map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <button
                      type="submit"
                      className="w-full py-2 rounded bg-slate-900 text-white font-medium hover:bg-slate-800 transition"
                    >
                      {t.saveChangesBtn}
                    </button>
                  </form>
                );
              }

              if (drawer.entityType === 'income') {
                const inc =
                  budget.allIncomes.find((i) => i.id === drawer.entityId) ||
                  wealth.salaryHistory.find((i) => i.id === drawer.entityId);
                if (!inc) return null;

                return (
                  <form
                    key={`edit-inc-${inc.id}`}
                    className="p-3.5 rounded-lg border border-slate-200 bg-[#FAF9F6]/60 space-y-2.5 text-xs"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const fd = new FormData(e.currentTarget);
                      const nextName = String(fd.get('name') || inc.name).trim();
                      const nextPortal = String(fd.get('portalUrl') || '').trim() || null;
                      const nextNotes = String(fd.get('notes') || '').trim() || null;

                      await apiFetch('/api/incomes', {
                        method: 'POST',
                        body: JSON.stringify({
                          id: inc.id,
                          workspaceId: fd.get('workspaceId') || inc.workspaceId,
                          accountId: fd.get('accountId') || null,
                          name: nextName,
                          sourceKind: inc.sourceKind,
                          amountMinor: Math.round(Number(fd.get('amountMajor') || 0) * 100),
                          currency: fd.get('currency') || inc.currency,
                          cadence: fd.get('cadence') || inc.cadence,
                          paydayDay: Number(fd.get('paydayDay') || inc.paydayDay),
                          effectiveFrom: fd.get('effectiveFrom') || inc.effectiveFrom,
                          effectiveTo: fd.get('effectiveTo') || null,
                          isActive: true,
                          portalUrl: nextPortal,
                          notes: nextNotes,
                        }),
                      });
                      setDrawer((prev) =>
                        prev ? { ...prev, title: nextName, portalUrl: nextPortal, notes: nextNotes } : null
                      );
                      setDrawerSavedMsg(t.savedNotice);
                      setTimeout(() => setDrawerSavedMsg(null), 3000);
                      await reloadAll();
                    }}
                  >
                    <div className="text-[11px] font-mono-num uppercase text-slate-600 font-semibold flex items-center gap-1.5">
                      <Pencil className="w-3 h-3 text-teal-700" /> {t.editDetailsTitle}
                    </div>
                    <label className="block space-y-1">
                      <span className="text-slate-600">{t.renameLabel}</span>
                      <input
                        required
                        name="name"
                        defaultValue={inc.name}
                        className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5"
                      />
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="text-slate-600">Workspace</span>
                        <select
                          name="workspaceId"
                          defaultValue={inc.workspaceId}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                        >
                          {writableWorkspaces.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">Payday (1-28)</span>
                        <input
                          type="number"
                          min={1}
                          max={28}
                          name="paydayDay"
                          defaultValue={inc.paydayDay}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                    </div>
                    <label className="block space-y-1">
                      <span className="text-slate-600">{t.depositIntoAccountLabel}</span>
                      <select
                        name="accountId"
                        defaultValue={inc.accountId || ''}
                        className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                      >
                        <option value="">{t.noAccountLinkOption}</option>
                        {allAvailableAccounts.map((acc) => (
                          <option key={acc.id} value={acc.id}>
                            🏦 {acc.name} ({acc.institution} · {acc.currency})
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      <label className="space-y-1">
                        <span className="text-slate-600">{t.amountValueLabel}</span>
                        <input
                          required
                          type="number"
                          step="0.01"
                          name="amountMajor"
                          defaultValue={(inc.amountMinor / 100).toFixed(2)}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">Currency</span>
                        <select
                          name="currency"
                          defaultValue={inc.currency}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        >
                          {(['GBP', 'EUR', 'PLN', 'USD', 'CHF'] as CurrencyCode[]).map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">Cadence</span>
                        <select
                          name="cadence"
                          defaultValue={inc.cadence}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                        >
                          <option value="monthly">Monthly</option>
                          <option value="annual">Annual</option>
                        </select>
                      </label>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="text-slate-600">Effective From</span>
                        <input
                          required
                          type="date"
                          name="effectiveFrom"
                          defaultValue={inc.effectiveFrom}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">Effective To</span>
                        <input
                          type="date"
                          name="effectiveTo"
                          defaultValue={inc.effectiveTo || ''}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                    </div>
                    <label className="block space-y-1">
                      <span className="text-slate-600">{t.portalUrlLabel}</span>
                      <input
                        type="url"
                        name="portalUrl"
                        defaultValue={inc.portalUrl || ''}
                        placeholder="https://..."
                        className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5"
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-slate-600">{t.notesInputLabel}</span>
                      <input
                        name="notes"
                        defaultValue={inc.notes || ''}
                        className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5"
                      />
                    </label>
                    <button
                      type="submit"
                      className="w-full py-2 rounded bg-slate-900 text-white font-medium hover:bg-slate-800 transition"
                    >
                      {t.saveChangesBtn}
                    </button>
                  </form>
                );
              }

              if (drawer.entityType === 'account') {
                const acc = allAvailableAccounts.find((a) => a.id === drawer.entityId);
                if (!acc) return null;
                const analytics = (budget.accountAnalytics || []).find((a) => a.accountId === acc.id);
                const accountTransfers = (budget.transfers || []).filter(
                  (tr) => tr.fromAccountId === acc.id || tr.toAccountId === acc.id
                );

                return (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setDrawer(null);
                          openTransferModal({ mode: 'single', defaultSourceAccountId: acc.id });
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-teal-700 text-white text-xs font-medium hover:bg-teal-800 transition"
                      >
                        <ArrowLeftRight className="w-3.5 h-3.5" /> Transfer From Here
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDrawer(null);
                          openTransferModal({ mode: 'single', defaultDestAccountId: acc.id });
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-teal-700 bg-teal-50 text-teal-900 text-xs font-medium hover:bg-teal-100 transition"
                      >
                        <ArrowLeftRight className="w-3.5 h-3.5" /> Top Up This Account
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDrawer(null);
                          openTransferModal({ mode: 'distribute', defaultSourceAccountId: acc.id });
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-slate-300 bg-white text-slate-800 text-xs font-medium hover:bg-slate-100 transition"
                      >
                        {t.salaryDistTab}
                      </button>
                    </div>

                    {analytics &&
                      (analytics.lockedPreserveDisplayMinor > 0 ||
                        analytics.unpaidPrePaydayDisplayMinor > 0 ||
                        analytics.pocketMoneyTargetMinor > 0 ||
                        (analytics.pendingDebitMinor ?? 0) > 0) && (
                        <div className="p-3 rounded-lg border border-amber-200 bg-amber-50/60 space-y-2 text-xs font-mono-num">
                          <div className="text-[11px] uppercase tracking-wider font-semibold text-amber-950 flex items-center gap-1.5">
                            <PiggyBank className="w-3.5 h-3.5 text-amber-700" /> Account Balance & Earmarked Reserves Breakdown
                          </div>
                          <div className="space-y-1">
                            <div className="flex justify-between text-slate-700">
                              <span>Available Balance on Account:</span>
                              <span className="font-semibold">
                                {formatDisplayValue(acc.balanceMinor, { currency: acc.currency, privacyMode })}
                              </span>
                            </div>
                            {analytics.bookedBalanceMinor != null && analytics.bookedBalanceMinor !== acc.balanceMinor && (
                              <div className="flex justify-between text-slate-500">
                                <span>Booked (Ledger) Balance:</span>
                                <span>
                                  {formatDisplayValue(analytics.bookedBalanceMinor, { currency: acc.currency, privacyMode })}
                                </span>
                              </div>
                            )}
                            {analytics.lockedPreserveDisplayMinor > 0 && (
                              <>
                                <div className="flex justify-between text-amber-900">
                                  <span>🔒 Planned Annual Reserves:</span>
                                  <span className="font-semibold">-{fmt(analytics.lockedPreserveDisplayMinor)}</span>
                                </div>
                                {analytics.fundedPreserveDisplayMinor != null && (
                                  <div className="flex justify-between text-teal-900">
                                    <span>✓ Actually Funded Reserves:</span>
                                    <span className="font-semibold">{fmt(analytics.fundedPreserveDisplayMinor)}</span>
                                  </div>
                                )}
                                {analytics.unfundedPreserveShortfallDisplayMinor > 0 && (
                                  <div className="flex justify-between text-rose-700 font-semibold">
                                    <span>⚠ Reserve Shortfall (Underfunded):</span>
                                    <span>-{fmt(analytics.unfundedPreserveShortfallDisplayMinor)}</span>
                                  </div>
                                )}
                                <div className="pl-2.5 border-l-2 border-amber-300 space-y-1 text-[10.5px] text-slate-600 my-1">
                                  {analytics.lockedItems.map((li) => (
                                    <div key={li.obligationId} className="flex justify-between gap-2">
                                      <span className="truncate">
                                        {li.name} (due {li.nextDueDate})
                                      </span>
                                      <span className="shrink-0 font-semibold text-amber-900">
                                        {fmt(li.preservedDisplayMinor)} / {fmt(li.targetDisplayMinor)}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </>
                            )}
                            <div className="flex justify-between text-emerald-900 pt-1 border-t border-amber-200/70">
                              <span className="font-semibold">✓ Real Free / Available Money:</span>
                              <span className="font-bold text-sm">{fmt(analytics.trueAvailableDisplayMinor)}</span>
                            </div>
                            {analytics.pocketMoneyTargetMinor > 0 && (
                              <div className="flex justify-between text-teal-900 pt-1">
                                <span>🎯 Spendable Pocket Money (Capped by Cash):</span>
                                <span className="font-semibold">
                                  {formatDisplayValue(
                                    analytics.spendablePocketMoneyMinor ??
                                      Math.min(analytics.pocketMoneyRemainingMinor, analytics.trueAvailableMinor),
                                    { currency: acc.currency, privacyMode }
                                  )}{' '}
                                  (Allowance left:{' '}
                                  {formatDisplayValue(analytics.pocketMoneyRemainingMinor, {
                                    currency: acc.currency,
                                    privacyMode,
                                  })}
                                  )
                                </span>
                              </div>
                            )}
                            {analytics.unpaidPrePaydayDisplayMinor > 0 && (
                              <div className="flex justify-between text-slate-600 pt-1">
                                <span>Scheduled Bills Before Payday:</span>
                                <span
                                  className={
                                    !analytics.isPrePaydaySufficient ? 'text-rose-700 font-bold' : 'text-slate-800'
                                  }
                                >
                                  {fmt(analytics.unpaidPrePaydayDisplayMinor)}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                    <form
                      key={`edit-acc-${acc.id}`}
                      className="p-3.5 rounded-lg border border-slate-200 bg-[#FAF9F6]/60 space-y-2.5 text-xs"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        const fd = new FormData(e.currentTarget);
                        const nextName = String(fd.get('name') || acc.name).trim();
                        const nextInst = String(fd.get('institution') || '').trim();
                        const nextPortal = String(fd.get('portalUrl') || '').trim() || null;
                        const nextNotes = String(fd.get('notes') || '').trim() || null;

                        await apiFetch('/api/accounts', {
                          method: 'POST',
                          body: JSON.stringify({
                            id: acc.id,
                            workspaceId: fd.get('workspaceId') || acc.workspaceId,
                            name: nextName,
                            institution: nextInst,
                            balanceMinor: Math.round(Number(fd.get('balanceMajor') || 0) * 100),
                            currency: fd.get('currency') || acc.currency,
                            isPrimaryRunway: fd.get('isPrimaryRunway') === 'on',
                            pocketMoneyTargetMinor: Math.round(Number(fd.get('pocketMoneyTargetMajor') || 0) * 100),
                            portalUrl: nextPortal,
                            notes: nextNotes,
                          }),
                        });
                        setDrawer((prev) =>
                          prev
                            ? { ...prev, title: nextName, subtitle: nextInst, portalUrl: nextPortal, notes: nextNotes }
                            : null
                        );
                        setDrawerSavedMsg(t.savedNotice);
                        setTimeout(() => setDrawerSavedMsg(null), 3000);
                        await reloadAll();
                      }}
                    >
                      <div className="text-[11px] font-mono-num uppercase text-slate-600 font-semibold flex items-center gap-1.5">
                        <Pencil className="w-3 h-3 text-teal-700" /> {t.editDetailsTitle}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <label className="space-y-1">
                          <span className="text-slate-600">{t.renameLabel}</span>
                          <input
                            required
                            name="name"
                            defaultValue={acc.name}
                            className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                          />
                        </label>
                        <label className="space-y-1">
                          <span className="text-slate-600">Institution</span>
                          <input
                            name="institution"
                            defaultValue={acc.institution}
                            className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                          />
                        </label>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <label className="space-y-1">
                          <span className="text-slate-600">Workspace</span>
                          <select
                            name="workspaceId"
                            defaultValue={acc.workspaceId}
                            className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                          >
                            {writableWorkspaces.map((w) => (
                              <option key={w.id} value={w.id}>
                                {w.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="space-y-1">
                          <span className="text-slate-600">Balance</span>
                          <input
                            required
                            type="number"
                            step="0.01"
                            name="balanceMajor"
                            defaultValue={(acc.balanceMinor / 100).toFixed(2)}
                            className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                          />
                        </label>
                        <label className="space-y-1">
                          <span className="text-slate-600">Currency</span>
                          <select
                            name="currency"
                            defaultValue={acc.currency}
                            className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                          >
                            {(['GBP', 'EUR', 'PLN', 'USD', 'CHF'] as CurrencyCode[]).map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <label className="block space-y-1">
                        <span className="text-teal-900 font-medium">
                          🎯 Monthly Pocket Money / Small Spending Allowance (0 = disabled)
                        </span>
                        <input
                          type="number"
                          step="1"
                          name="pocketMoneyTargetMajor"
                          defaultValue={((acc.pocketMoneyTargetMinor || 0) / 100).toFixed(2)}
                          placeholder="e.g. 150.00"
                          className="w-full border border-teal-300 bg-white rounded px-2.5 py-1.5 font-mono-num"
                        />
                      </label>
                      <label className="flex items-center gap-2">
                        <input type="checkbox" name="isPrimaryRunway" defaultChecked={acc.isPrimaryRunway} />
                        <span className="text-slate-600">Include in monthly sufficiency runway check</span>
                      </label>
                      <label className="block space-y-1">
                        <span className="text-slate-600">{t.portalUrlLabel}</span>
                        <input
                          type="url"
                          name="portalUrl"
                          defaultValue={acc.portalUrl || ''}
                          placeholder="https://..."
                          className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5"
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-slate-600">{t.notesInputLabel}</span>
                        <input
                          name="notes"
                          defaultValue={acc.notes || ''}
                          placeholder="Account owners, routing notes, historical transfers..."
                          className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5"
                        />
                      </label>
                      <button
                        type="submit"
                        className="w-full py-2 rounded bg-slate-900 text-white font-medium hover:bg-slate-800 transition"
                      >
                        {t.saveChangesBtn}
                      </button>
                    </form>

                    {accountTransfers.length > 0 && (
                      <div className="p-3 rounded-lg border border-slate-200 bg-white space-y-2 text-xs">
                        <div className="text-[11px] font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                          Internal Transfers This Month ({accountTransfers.length})
                        </div>
                        <div className="divide-y divide-slate-100">
                          {accountTransfers.map((tr) => {
                            const isSource = tr.fromAccountId === acc.id;
                            const otherAcc = allAvailableAccounts.find(
                              (a) => a.id === (isSource ? tr.toAccountId : tr.fromAccountId)
                            );
                            return (
                              <div key={tr.id} className="py-1.5 flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="font-medium text-slate-800 truncate">
                                    {isSource ? `→ To ${otherAcc?.name || tr.toAccountId}` : `← From ${otherAcc?.name || tr.fromAccountId}`}
                                  </div>
                                  <div className="text-[10.5px] text-slate-400 font-mono-num">
                                    {tr.transferDate} · {tr.description || 'Internal transfer'}
                                  </div>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  <span
                                    className={`font-mono-num font-semibold ${
                                      isSource ? 'text-rose-700' : 'text-emerald-700'
                                    }`}
                                  >
                                    {isSource ? '-' : '+'}
                                    {formatDisplayValue(
                                      isSource ? tr.fromAmountMinor : tr.toAmountMinor,
                                      { currency: isSource ? tr.fromCurrency : tr.toCurrency, privacyMode }
                                    )}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      if (!confirm('Reverse & delete this internal transfer?')) return;
                                      await deleteTransferApi(tr.id);
                                      await reloadAll();
                                    }}
                                    className="text-slate-400 hover:text-rose-600"
                                    title="Reverse transfer"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              }

              if (drawer.entityType === 'asset') {
                const ast = wealth.assets.find((a) => a.id === drawer.entityId);
                if (!ast) return null;

                return (
                  <form
                    key={`edit-ast-${ast.id}`}
                    className="p-3.5 rounded-lg border border-slate-200 bg-[#FAF9F6]/60 space-y-2.5 text-xs"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const fd = new FormData(e.currentTarget);
                      const nextName = String(fd.get('name') || ast.name).trim();
                      const nextManage = String(fd.get('manageUrl') || '').trim() || null;
                      const nextPortal = String(fd.get('portalUrl') || '').trim() || null;
                      const nextRef = String(fd.get('referenceNumber') || '').trim() || null;
                      const nextNotes = String(fd.get('notes') || '').trim() || null;

                      await apiFetch('/api/assets', {
                        method: 'POST',
                        body: JSON.stringify({
                          id: ast.id,
                          workspaceId: fd.get('workspaceId') || ast.workspaceId,
                          name: nextName,
                          assetClass: fd.get('assetClass') || ast.assetClass,
                          purchaseDate: ast.purchaseDate,
                          purchasePriceMinor: Math.round(Number(fd.get('purchasePriceMajor') || 0) * 100),
                          currentValueMinor: Math.round(Number(fd.get('currentValueMajor') || 0) * 100),
                          currency: fd.get('currency') || ast.currency,
                          curveModel: ast.curveModel,
                          annualRateBp: Math.round(Number(fd.get('annualRatePct') || 0) * 100),
                          residualFloorMinor: Math.round(Number(fd.get('residualFloorMajor') || 0) * 100),
                          manageUrl: nextManage,
                          portalUrl: nextPortal,
                          referenceNumber: nextRef,
                          notes: nextNotes,
                        }),
                      });
                      setDrawer((prev) =>
                        prev
                          ? {
                              ...prev,
                              title: nextName,
                              manageUrl: nextManage,
                              portalUrl: nextPortal,
                              referenceNumber: nextRef,
                              notes: nextNotes,
                            }
                          : null
                      );
                      setDrawerSavedMsg(t.savedNotice);
                      setTimeout(() => setDrawerSavedMsg(null), 3000);
                      await reloadAll();
                    }}
                  >
                    <div className="text-[11px] font-mono-num uppercase text-slate-600 font-semibold flex items-center gap-1.5">
                      <Pencil className="w-3 h-3 text-teal-700" /> {t.editDetailsTitle}
                    </div>
                    <label className="block space-y-1">
                      <span className="text-slate-600">{t.renameLabel}</span>
                      <input
                        required
                        name="name"
                        defaultValue={ast.name}
                        className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5"
                      />
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="text-slate-600">Workspace</span>
                        <select
                          name="workspaceId"
                          defaultValue={ast.workspaceId}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                        >
                          {writableWorkspaces.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">Category</span>
                        <select
                          name="assetClass"
                          defaultValue={ast.assetClass}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                        >
                          <option value="property">Property / House</option>
                          <option value="vehicle">Car / Motorcycle</option>
                          <option value="belonging">Belonging / Gear</option>
                          <option value="investment">Investment / ISA</option>
                        </select>
                      </label>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <label className="space-y-1">
                        <span className="text-slate-600">Current Value</span>
                        <input
                          required
                          type="number"
                          step="0.01"
                          name="currentValueMajor"
                          defaultValue={(ast.currentValueMinor / 100).toFixed(2)}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">Currency</span>
                        <select
                          name="currency"
                          defaultValue={ast.currency}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        >
                          {(['GBP', 'EUR', 'PLN', 'USD', 'CHF'] as CurrencyCode[]).map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">Annual %</span>
                        <input
                          required
                          type="number"
                          step="0.1"
                          name="annualRatePct"
                          defaultValue={(ast.annualRateBp / 100).toFixed(1)}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="text-slate-600">Purchase Price</span>
                        <input
                          type="number"
                          step="0.01"
                          name="purchasePriceMajor"
                          defaultValue={(ast.purchasePriceMinor / 100).toFixed(2)}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">Residual Floor</span>
                        <input
                          type="number"
                          step="0.01"
                          name="residualFloorMajor"
                          defaultValue={(ast.residualFloorMinor / 100).toFixed(2)}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                    </div>
                    <label className="block space-y-1">
                      <span className="text-slate-600">{t.manageUrlLabel}</span>
                      <input
                        type="url"
                        name="manageUrl"
                        defaultValue={ast.manageUrl || ''}
                        placeholder="https://..."
                        className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5"
                      />
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="text-slate-600">{t.portalUrlLabel}</span>
                        <input
                          type="url"
                          name="portalUrl"
                          defaultValue={ast.portalUrl || ''}
                          placeholder="https://..."
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">{t.refPolicyInputLabel}</span>
                        <input
                          name="referenceNumber"
                          defaultValue={ast.referenceNumber || ''}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                    </div>
                    <label className="block space-y-1">
                      <span className="text-slate-600">{t.notesInputLabel}</span>
                      <input
                        name="notes"
                        defaultValue={ast.notes || ''}
                        className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5"
                      />
                    </label>
                    <button
                      type="submit"
                      className="w-full py-2 rounded bg-slate-900 text-white font-medium hover:bg-slate-800 transition"
                    >
                      {t.saveChangesBtn}
                    </button>
                  </form>
                );
              }

              if (drawer.entityType === 'liability') {
                const lb = wealth.liabilities.find((l) => l.id === drawer.entityId);
                if (!lb) return null;

                return (
                  <form
                    key={`edit-lb-${lb.id}`}
                    className="p-3.5 rounded-lg border border-slate-200 bg-[#FAF9F6]/60 space-y-2.5 text-xs"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const fd = new FormData(e.currentTarget);
                      const nextName = String(fd.get('name') || lb.name).trim();
                      const nextPortal = String(fd.get('portalUrl') || '').trim() || null;
                      const nextRef = String(fd.get('referenceNumber') || '').trim() || null;
                      const nextNotes = String(fd.get('notes') || '').trim() || null;

                      await apiFetch('/api/liabilities', {
                        method: 'POST',
                        body: JSON.stringify({
                          id: lb.id,
                          workspaceId: fd.get('workspaceId') || lb.workspaceId,
                          linkedAssetId: lb.linkedAssetId,
                          name: nextName,
                          kind: fd.get('kind') || lb.kind,
                          balanceMinor: Math.round(Number(fd.get('balanceMajor') || 0) * 100),
                          aprBp: Math.round(Number(fd.get('aprPct') || 0) * 100),
                          monthlyPaymentMinor: Math.round(Number(fd.get('monthlyMajor') || 0) * 100),
                          currency: fd.get('currency') || lb.currency,
                          endDate: lb.endDate,
                          portalUrl: nextPortal,
                          referenceNumber: nextRef,
                          notes: nextNotes,
                        }),
                      });
                      setDrawer((prev) =>
                        prev
                          ? {
                              ...prev,
                              title: nextName,
                              portalUrl: nextPortal,
                              referenceNumber: nextRef,
                              notes: nextNotes,
                            }
                          : null
                      );
                      setDrawerSavedMsg(t.savedNotice);
                      setTimeout(() => setDrawerSavedMsg(null), 3000);
                      await reloadAll();
                    }}
                  >
                    <div className="text-[11px] font-mono-num uppercase text-slate-600 font-semibold flex items-center gap-1.5">
                      <Pencil className="w-3 h-3 text-teal-700" /> {t.editDetailsTitle}
                    </div>
                    <label className="block space-y-1">
                      <span className="text-slate-600">{t.renameLabel}</span>
                      <input
                        required
                        name="name"
                        defaultValue={lb.name}
                        className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5"
                      />
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="text-slate-600">Workspace</span>
                        <select
                          name="workspaceId"
                          defaultValue={lb.workspaceId}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                        >
                          {writableWorkspaces.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">Type</span>
                        <select
                          name="kind"
                          defaultValue={lb.kind}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                        >
                          <option value="mortgage">Mortgage</option>
                          <option value="loan">Loan</option>
                          <option value="credit_card">Credit Card</option>
                        </select>
                      </label>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <label className="space-y-1">
                        <span className="text-slate-600">Balance</span>
                        <input
                          required
                          type="number"
                          step="0.01"
                          name="balanceMajor"
                          defaultValue={(lb.balanceMinor / 100).toFixed(2)}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">APR %</span>
                        <input
                          required
                          type="number"
                          step="0.01"
                          name="aprPct"
                          defaultValue={(lb.aprBp / 100).toFixed(2)}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">Monthly</span>
                        <input
                          required
                          type="number"
                          step="0.01"
                          name="monthlyMajor"
                          defaultValue={(lb.monthlyPaymentMinor / 100).toFixed(2)}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="text-slate-600">{t.portalUrlLabel}</span>
                        <input
                          type="url"
                          name="portalUrl"
                          defaultValue={lb.portalUrl || ''}
                          placeholder="https://..."
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">{t.refPolicyInputLabel}</span>
                        <input
                          name="referenceNumber"
                          defaultValue={lb.referenceNumber || ''}
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 font-mono-num"
                        />
                      </label>
                    </div>
                    <label className="block space-y-1">
                      <span className="text-slate-600">{t.notesInputLabel}</span>
                      <input
                        name="notes"
                        defaultValue={lb.notes || ''}
                        className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5"
                      />
                    </label>
                    <button
                      type="submit"
                      className="w-full py-2 rounded bg-slate-900 text-white font-medium hover:bg-slate-800 transition"
                    >
                      {t.saveChangesBtn}
                    </button>
                  </form>
                );
              }

              return null;
            })()}

            {drawer.items && drawer.items.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[11px] font-mono-num uppercase text-slate-500 font-semibold">
                  {t.itemizedSubTitle}
                </div>
                <div className="border border-slate-200 rounded-md divide-y divide-slate-100">
                  {drawer.items.map((it) => (
                    <div key={it.id} className="px-3 py-2 flex justify-between text-xs">
                      <div>
                        <span className="font-medium">{it.name}</span>
                        {it.subCategory && <span className="text-slate-400"> · {it.subCategory}</span>}
                      </div>
                      <span className="font-mono-num">
                        {privacyMode
                          ? '•••'
                          : `${CURRENCY_SYMBOLS[drawer.currency]}${(it.amountMinor / 100).toFixed(2)}`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {drawer.notes && (
              <div className="text-xs text-slate-600 bg-slate-50 p-3 rounded border border-slate-100">
                {drawer.notes}
              </div>
            )}

            <div className="space-y-3 pt-2 border-t border-slate-200">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                  {t.attachmentsTitle} ({drawerAttachments.length})
                </span>
                <label className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-900 text-white text-xs cursor-pointer">
                  <Upload className="w-3 h-3" /> {t.attachFileBtn}
                  <input
                    type="file"
                    accept="image/*,application/pdf"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const fd = new FormData();
                      fd.append('workspaceId', drawer.workspaceId);
                      fd.append('entityType', drawer.entityType);
                      fd.append('entityId', drawer.entityId);
                      fd.append('file', file);
                      await apiFetch('/api/attachments', { method: 'POST', body: fd });
                      const updated = await listAttachmentsApi(drawer.entityType, drawer.entityId);
                      setDrawerAttachments(updated);
                    }}
                  />
                </label>
              </div>

              {drawerAttachments.length === 0 ? (
                <div className="text-xs text-slate-400">{t.noAttachments}</div>
              ) : (
                <div className="space-y-2">
                  {drawerAttachments.map((att) => (
                    <div
                      key={att.id}
                      className="border border-slate-200 rounded-md px-3 py-2 flex items-center justify-between text-xs"
                    >
                      <a
                        href={`/api/attachments/${att.id}/file`}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-2 text-teal-800 hover:underline truncate"
                      >
                        <FileText className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">{att.originalName}</span>
                      </a>
                      <button
                        type="button"
                        onClick={async () => {
                          await apiFetch(`/api/attachments/${att.id}`, { method: 'DELETE' });
                          setDrawerAttachments((prev) => prev.filter((x) => x.id !== att.id));
                        }}
                        className="text-slate-400 hover:text-rose-600"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="pt-4 border-t border-slate-100">
              <button
                type="button"
                onClick={async () => {
                  if (!confirm(`Delete "${drawer.title}"?`)) return;
                  const endpoint =
                    drawer.entityType === 'obligation'
                      ? `/api/obligations/${drawer.entityId}`
                      : drawer.entityType === 'expense'
                      ? `/api/expenses/${drawer.entityId}`
                      : drawer.entityType === 'asset'
                      ? `/api/assets/${drawer.entityId}`
                      : drawer.entityType === 'pot'
                      ? `/api/pots/${drawer.entityId}`
                      : drawer.entityType === 'income'
                      ? `/api/incomes/${drawer.entityId}`
                      : drawer.entityType === 'account'
                      ? `/api/accounts/${drawer.entityId}`
                      : `/api/liabilities/${drawer.entityId}`;
                  await apiFetch(endpoint, { method: 'DELETE' });
                  setDrawer(null);
                  await reloadAll();
                }}
                className="text-xs text-rose-600 hover:underline inline-flex items-center gap-1"
              >
                <Trash2 className="w-3.5 h-3.5" /> {t.deleteRecordBtn}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ======================== CREATION MODALS ======================== */}
      {modal && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/35 flex items-center justify-center p-4"
          onClick={() => setModal(null)}
        >
          <div
            className="bg-white border border-slate-200 rounded-xl max-w-lg w-full p-6 space-y-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 capitalize">
                {modal.kind === 'workspace'
                  ? t.createWorkspaceBtn
                  : modal.kind === 'transfer'
                  ? t.moveMoneyTitle
                  : `+ ${modal.kind}`}
              </h3>
              <button type="button" onClick={() => setModal(null)}>
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>

            {modal.kind === 'workspace' && (
              <form
                className="space-y-3 text-xs"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  const res = await apiFetch<{ workspace: { id: string } }>('/api/workspaces', {
                    method: 'POST',
                    body: JSON.stringify({
                      name: fd.get('name'),
                      kind: fd.get('kind'),
                    }),
                  });
                  setModal(null);
                  await reloadAll();
                  setScope(res.workspace.id);
                }}
              >
                <label className="block space-y-1">
                  <span>Workspace Name</span>
                  <input
                    required
                    name="name"
                    placeholder={t.wsNamePlaceholder}
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5"
                  />
                </label>
                <label className="block space-y-1">
                  <span>Kind</span>
                  <select name="kind" defaultValue="company" className="w-full border border-slate-200 rounded px-2 py-1.5">
                    <option value="company">{t.wsKindCompany}</option>
                    <option value="shared">{t.wsKindShared}</option>
                    <option value="personal">{t.wsKindPersonal}</option>
                  </select>
                </label>
                <button type="submit" className="w-full py-2 rounded bg-slate-900 text-white font-medium">
                  {t.createWorkspaceBtn}
                </button>
              </form>
            )}

            {modal.kind === 'obligation' && (
              <form
                className="space-y-3 text-xs"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  await apiFetch('/api/obligations', {
                    method: 'POST',
                    body: JSON.stringify({
                      workspaceId: fd.get('workspaceId'),
                      potId: fd.get('potId') || null,
                      accountId: fd.get('accountId') || null,
                      preserveAccountId: fd.get('preserveAccountId') || null,
                      liabilityId: fd.get('liabilityId') || null,
                      name: fd.get('name'),
                      amountMinor: Math.round(Number(fd.get('amountMajor') || 0) * 100),
                      currency: fd.get('currency'),
                      cadence: fd.get('cadence'),
                      intervalMonths: Number(fd.get('intervalMonths') || 1),
                      nextDueDate: fd.get('nextDueDate'),
                      preservedMinor: Math.round(Number(fd.get('preservedMajor') || 0) * 100),
                      autoPreserve: fd.get('autoPreserve') === 'on',
                      manageUrl: fd.get('manageUrl') || null,
                      notes: fd.get('notes') || null,
                    }),
                  });
                  setModal(null);
                  await reloadAll();
                }}
              >
                <div className="grid grid-cols-2 gap-2.5">
                  <label className="space-y-1">
                    <span>Workspace</span>
                    <select
                      name="workspaceId"
                      defaultValue={defaultActiveWsId}
                      className="w-full border border-slate-200 rounded px-2 py-1.5"
                    >
                      {writableWorkspaces.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span>Pot (any nesting depth)</span>
                    <select
                      name="potId"
                      defaultValue={modal.defaultPotId || selectedPotId || ''}
                      className="w-full border border-slate-200 rounded px-2 py-1.5"
                    >
                      <option value="">— Unassigned —</option>
                      {budget.pots.map((p) => (
                        <option key={p.id} value={p.id}>
                          {potBreadcrumbs.get(p.id)?.pathString || p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="p-2.5 rounded-md bg-teal-50/60 border border-teal-200/80 space-y-2">
                  <label className="block space-y-1">
                    <span className="font-semibold text-teal-950">{t.paidFromAccountLabel}</span>
                    <select
                      name="accountId"
                      defaultValue={defaultAccountForWs(defaultActiveWsId)}
                      className="w-full border border-teal-300 bg-white rounded px-2 py-1.5 font-medium"
                    >
                      <option value="">{t.noAccountLinkOption}</option>
                      {allAvailableAccounts.map((acc) => (
                        <option key={acc.id} value={acc.id}>
                          🏦 {acc.name} ({acc.institution} · {formatDisplayValue(acc.balanceMinor, { currency: acc.currency, privacyMode })})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block space-y-1">
                    <span className="font-medium text-teal-900">🔒 Sinking Reserve ("Preserve") Held on Account</span>
                    <select
                      name="preserveAccountId"
                      defaultValue=""
                      className="w-full border border-teal-200 bg-white rounded px-2 py-1.5"
                    >
                      <option value="">— Default (Saver / Same as Payment Account) —</option>
                      {allAvailableAccounts.map((acc) => (
                        <option key={acc.id} value={acc.id}>
                          🏦 {acc.name} ({acc.institution} · {formatDisplayValue(acc.balanceMinor, { currency: acc.currency, privacyMode })})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block space-y-1">
                    <span className="font-medium text-slate-700">{t.linkedLiabilityLabel}</span>
                    <select
                      name="liabilityId"
                      defaultValue=""
                      className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                    >
                      <option value="">{t.noLiabilityLinkOption}</option>
                      {allAvailableLiabilities.map((lb) => (
                        <option key={lb.id} value={lb.id}>
                          🏠 {lb.name} ({formatDisplayValue(lb.balanceMinor, { currency: lb.currency, privacyMode })} · {(lb.aprBp / 100).toFixed(2)}% APR)
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="block space-y-1">
                  <span>Payment / Goal Name</span>
                  <input
                    required
                    name="name"
                    placeholder="e.g. Electricity, Car Insurance, Netflix"
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5"
                  />
                </label>

                <div className="grid grid-cols-3 gap-2">
                  <label className="space-y-1">
                    <span>Amount</span>
                    <input
                      required
                      type="number"
                      step="0.01"
                      name="amountMajor"
                      placeholder="150.00"
                      className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                    />
                  </label>
                  <label className="space-y-1">
                    <span>Currency</span>
                    <select
                      name="currency"
                      defaultValue={cur}
                      className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                    >
                      {(['GBP', 'EUR', 'PLN', 'USD', 'CHF'] as CurrencyCode[]).map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span>Cadence</span>
                    <select
                      name="cadence"
                      defaultValue="monthly"
                      className="w-full border border-slate-200 rounded px-2 py-1.5"
                    >
                      <option value="monthly">Monthly</option>
                      <option value="annual">Yearly (12m)</option>
                      <option value="quarterly">Quarterly (3m)</option>
                      <option value="biannual">Every 6m</option>
                      <option value="once">One-Time Planned</option>
                    </select>
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <label className="space-y-1">
                    <span>Next Due Date</span>
                    <input
                      required
                      type="date"
                      name="nextDueDate"
                      defaultValue={`${yearMonth}-01`}
                      className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                    />
                  </label>
                  <label className="space-y-1">
                    <span>Already Preserved</span>
                    <input
                      type="number"
                      step="0.01"
                      name="preservedMajor"
                      defaultValue="0"
                      className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                    />
                  </label>
                </div>

                <label className="flex items-center gap-2 pt-1">
                  <input type="checkbox" name="autoPreserve" defaultChecked />
                  <span>Automatically budget monthly "Preserve" sinking slice until due date</span>
                </label>

                <label className="block space-y-1">
                  <span>Manage / Cancel Portal URL (optional)</span>
                  <input
                    type="url"
                    name="manageUrl"
                    placeholder="https://..."
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5"
                  />
                </label>

                <button type="submit" className="w-full py-2 rounded bg-slate-900 text-white font-medium">
                  {t.qaSave}
                </button>
              </form>
            )}

            {modal.kind === 'expense' && (
              <form
                className="space-y-3 text-xs"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  await apiFetch('/api/expenses', {
                    method: 'POST',
                    body: JSON.stringify({
                      workspaceId: fd.get('workspaceId'),
                      potId: fd.get('potId') || null,
                      accountId: fd.get('accountId') || null,
                      liabilityId: fd.get('liabilityId') || null,
                      flowDirection: fd.get('flowDirection') || 'outflow',
                      status: (fd.get('status') || 'posted') as TransactionStatus,
                      merchant: fd.get('merchant'),
                      description: fd.get('description'),
                      amountMinor: Math.round(Number(fd.get('amountMajor') || 0) * 100),
                      currency: fd.get('currency'),
                      spentDate: fd.get('spentDate'),
                    }),
                  });
                  setModal(null);
                  await reloadAll();
                }}
              >
                <div className="grid grid-cols-2 gap-2.5">
                  <label className="space-y-1">
                    <span>Workspace</span>
                    <select
                      name="workspaceId"
                      defaultValue={defaultActiveWsId}
                      className="w-full border border-slate-200 rounded px-2 py-1.5"
                    >
                      {writableWorkspaces.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span>Pot / Sub-Pot</span>
                    <select
                      name="potId"
                      defaultValue={modal.defaultPotId || selectedPotId || ''}
                      className="w-full border border-slate-200 rounded px-2 py-1.5"
                    >
                      <option value="">— Unassigned —</option>
                      {budget.pots.map((p) => (
                        <option key={p.id} value={p.id}>
                          {potBreadcrumbs.get(p.id)?.pathString || p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="p-2.5 rounded-md bg-teal-50/60 border border-teal-200/80 space-y-2">
                  <div className="grid grid-cols-2 gap-2.5">
                    <label className="space-y-1">
                      <span className="font-semibold text-teal-950">{t.bankAccountLabel}</span>
                      <select
                        name="accountId"
                        defaultValue={defaultAccountForWs(defaultActiveWsId)}
                        className="w-full border border-teal-300 bg-white rounded px-2 py-1.5 font-medium"
                      >
                        <option value="">{t.noAccountLinkOption}</option>
                        {allAvailableAccounts.map((acc) => (
                          <option key={acc.id} value={acc.id}>
                            🏦 {acc.name} ({formatDisplayValue(acc.balanceMinor, { currency: acc.currency, privacyMode })})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1">
                      <span className="font-semibold text-teal-950">{t.flowDirectionLabel}</span>
                      <select
                        name="flowDirection"
                        defaultValue="outflow"
                        className="w-full border border-teal-300 bg-white rounded px-2 py-1.5 font-medium"
                      >
                        <option value="outflow">{t.flowOutflowOption}</option>
                        <option value="inflow">{t.flowInflowOption}</option>
                      </select>
                    </label>
                  </div>
                  <label className="block space-y-1">
                    <span className="font-semibold text-teal-950">{t.txStatusLabel}</span>
                    <select
                      name="status"
                      defaultValue="posted"
                      className="w-full border border-teal-300 bg-white rounded px-2 py-1.5 font-medium"
                    >
                      <option value="posted">{t.txStatusPosted}</option>
                      <option value="pending">{t.txStatusPending}</option>
                    </select>
                  </label>
                  <label className="block space-y-1">
                    <span className="font-medium text-slate-700">{t.linkedLiabilityLabel}</span>
                    <select
                      name="liabilityId"
                      defaultValue=""
                      className="w-full border border-slate-200 bg-white rounded px-2 py-1.5"
                    >
                      <option value="">{t.noLiabilityLinkOption}</option>
                      {allAvailableLiabilities.map((lb) => (
                        <option key={lb.id} value={lb.id}>
                          🏠 {lb.name} ({formatDisplayValue(lb.balanceMinor, { currency: lb.currency, privacyMode })} · {(lb.aprBp / 100).toFixed(2)}% APR)
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="block space-y-1">
                  <span>Merchant / Shop</span>
                  <input
                    required
                    name="merchant"
                    placeholder="Aldi, Shell, Amazon..."
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5"
                  />
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <label className="space-y-1">
                    <span>Amount</span>
                    <input
                      required
                      type="number"
                      step="0.01"
                      name="amountMajor"
                      className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                    />
                  </label>
                  <label className="space-y-1">
                    <span>Currency</span>
                    <select
                      name="currency"
                      defaultValue={cur}
                      className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                    >
                      {(['GBP', 'EUR', 'PLN', 'USD', 'CHF'] as CurrencyCode[]).map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span>Date</span>
                    <input
                      required
                      type="date"
                      name="spentDate"
                      defaultValue={new Date().toISOString().slice(0, 10)}
                      className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                    />
                  </label>
                </div>
                <label className="block space-y-1">
                  <span>Notes</span>
                  <input
                    name="description"
                    placeholder="Optional details"
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5"
                  />
                </label>
                <button type="submit" className="w-full py-2 rounded bg-slate-900 text-white font-medium">
                  {t.qaSave}
                </button>
              </form>
            )}

            {modal.kind === 'pot' && (
              <form
                className="space-y-3 text-xs"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  const estMajor = Number(fd.get('monthlyEstimateMajor') || 0);
                  await apiFetch('/api/pots', {
                    method: 'POST',
                    body: JSON.stringify({
                      workspaceId: fd.get('workspaceId'),
                      parentId: fd.get('parentId') || null,
                      name: fd.get('name'),
                      color: fd.get('color') || '#2E6F7E',
                      envelopeMode: estMajor > 0,
                      monthlyEstimateMinor: Math.round(estMajor * 100),
                      currency: cur,
                    }),
                  });
                  setModal(null);
                  await reloadAll();
                }}
              >
                <div className="grid grid-cols-2 gap-2.5">
                  <label className="space-y-1">
                    <span>Workspace</span>
                    <select
                      name="workspaceId"
                      defaultValue={defaultActiveWsId}
                      className="w-full border border-slate-200 rounded px-2 py-1.5"
                    >
                      {writableWorkspaces.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span>Parent Pot (unlimited nesting)</span>
                    <select
                      name="parentId"
                      defaultValue={modal.defaultParentId || ''}
                      className="w-full border border-slate-200 rounded px-2 py-1.5"
                    >
                      <option value="">— Top-Level Pot —</option>
                      {budget.pots.map((p) => (
                        <option key={p.id} value={p.id}>
                          {potBreadcrumbs.get(p.id)?.pathString || p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <label className="col-span-2 space-y-1">
                    <span>Pot Name</span>
                    <input
                      required
                      name="name"
                      placeholder="e.g. Food, Butter, Car Maintenance"
                      className="w-full border border-slate-200 rounded px-2.5 py-1.5"
                    />
                  </label>
                  <label className="space-y-1">
                    <span>Color</span>
                    <input
                      type="color"
                      name="color"
                      defaultValue="#2E6F7E"
                      className="w-full h-8 border border-slate-200 rounded"
                    />
                  </label>
                </div>
                <label className="block space-y-1">
                  <span>Rough Monthly Envelope Estimate (0 = container/itemized)</span>
                  <input
                    type="number"
                    step="1"
                    name="monthlyEstimateMajor"
                    defaultValue="0"
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5 font-mono-num"
                  />
                </label>
                <button type="submit" className="w-full py-2 rounded bg-slate-900 text-white font-medium">
                  {t.qaSave}
                </button>
              </form>
            )}

            {modal.kind === 'asset' && (
              <form
                className="space-y-3 text-xs"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  await apiFetch('/api/assets', {
                    method: 'POST',
                    body: JSON.stringify({
                      workspaceId: fd.get('workspaceId'),
                      name: fd.get('name'),
                      assetClass: fd.get('assetClass'),
                      currentValueMinor: Math.round(Number(fd.get('currentValueMajor') || 0) * 100),
                      purchasePriceMinor: Math.round(Number(fd.get('purchasePriceMajor') || 0) * 100),
                      currency: fd.get('currency'),
                      annualRateBp: Math.round(Number(fd.get('annualRatePct') || 0) * 100),
                      residualFloorMinor: Math.round(Number(fd.get('residualFloorMajor') || 0) * 100),
                    }),
                  });
                  setModal(null);
                  await reloadAll();
                }}
              >
                <div className="grid grid-cols-2 gap-2.5">
                  <label className="space-y-1">
                    <span>Workspace</span>
                    <select
                      name="workspaceId"
                      defaultValue={defaultActiveWsId}
                      className="w-full border border-slate-200 rounded px-2 py-1.5"
                    >
                      {writableWorkspaces.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span>Category</span>
                    <select name="assetClass" className="w-full border border-slate-200 rounded px-2 py-1.5">
                      <option value="property">Property / House</option>
                      <option value="vehicle">Car / Motorcycle</option>
                      <option value="belonging">E-MTB / PC / Belonging</option>
                      <option value="investment">ISA / Investment</option>
                    </select>
                  </label>
                </div>
                <label className="block space-y-1">
                  <span>Item Name</span>
                  <input
                    required
                    name="name"
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5"
                  />
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <label className="space-y-1">
                    <span>Current Value</span>
                    <input
                      required
                      type="number"
                      step="1"
                      name="currentValueMajor"
                      className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                    />
                  </label>
                  <label className="space-y-1">
                    <span>Currency</span>
                    <select
                      name="currency"
                      defaultValue={cur}
                      className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                    >
                      {(['GBP', 'EUR', 'PLN', 'USD', 'CHF'] as CurrencyCode[]).map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span>Annual % (+ or -)</span>
                    <input
                      required
                      type="number"
                      step="0.1"
                      name="annualRatePct"
                      defaultValue="-15"
                      className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                    />
                  </label>
                </div>
                <button type="submit" className="w-full py-2 rounded bg-slate-900 text-white font-medium">
                  {t.qaSave}
                </button>
              </form>
            )}

            {modal.kind === 'liability' && (
              <form
                className="space-y-3 text-xs"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  await apiFetch('/api/liabilities', {
                    method: 'POST',
                    body: JSON.stringify({
                      workspaceId: fd.get('workspaceId'),
                      name: fd.get('name'),
                      kind: fd.get('kind'),
                      balanceMinor: Math.round(Number(fd.get('balanceMajor') || 0) * 100),
                      aprBp: Math.round(Number(fd.get('aprPct') || 0) * 100),
                      monthlyPaymentMinor: Math.round(Number(fd.get('monthlyMajor') || 0) * 100),
                      currency: cur,
                    }),
                  });
                  setModal(null);
                  await reloadAll();
                }}
              >
                <div className="grid grid-cols-2 gap-2.5">
                  <label className="space-y-1">
                    <span>Workspace</span>
                    <select
                      name="workspaceId"
                      defaultValue={defaultActiveWsId}
                      className="w-full border border-slate-200 rounded px-2 py-1.5"
                    >
                      {writableWorkspaces.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span>Type</span>
                    <select name="kind" className="w-full border border-slate-200 rounded px-2 py-1.5">
                      <option value="mortgage">Mortgage</option>
                      <option value="loan">Loan</option>
                      <option value="credit_card">Credit Card</option>
                    </select>
                  </label>
                </div>
                <label className="block space-y-1">
                  <span>Liability Name</span>
                  <input required name="name" className="w-full border border-slate-200 rounded px-2.5 py-1.5" />
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <label className="space-y-1">
                    <span>Balance</span>
                    <input
                      required
                      type="number"
                      step="0.01"
                      name="balanceMajor"
                      className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                    />
                  </label>
                  <label className="space-y-1">
                    <span>APR %</span>
                    <input
                      required
                      type="number"
                      step="0.01"
                      name="aprPct"
                      defaultValue="4.2"
                      className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                    />
                  </label>
                  <label className="space-y-1">
                    <span>Monthly Payment</span>
                    <input
                      required
                      type="number"
                      step="0.01"
                      name="monthlyMajor"
                      className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                    />
                  </label>
                </div>
                <button type="submit" className="w-full py-2 rounded bg-slate-900 text-white font-medium">
                  {t.qaSave}
                </button>
              </form>
            )}

            {modal.kind === 'income' && (
              <form
                className="space-y-3 text-xs"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  await apiFetch('/api/incomes', {
                    method: 'POST',
                    body: JSON.stringify({
                      workspaceId: fd.get('workspaceId') || boot.user.personalWorkspaceId,
                      accountId: fd.get('accountId') || null,
                      name: fd.get('name'),
                      amountMinor: Math.round(Number(fd.get('amountMajor') || 0) * 100),
                      currency: fd.get('currency'),
                      cadence: fd.get('cadence'),
                      paydayDay: Number(fd.get('paydayDay') || 27),
                      effectiveFrom: fd.get('effectiveFrom'),
                      effectiveTo: fd.get('effectiveTo') || null,
                      markReceivedYearMonth: fd.get('markReceivedNow') === 'on' ? yearMonth : undefined,
                    }),
                  });
                  setModal(null);
                  await reloadAll();
                }}
              >
                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1">
                    <span>Workspace</span>
                    <select
                      name="workspaceId"
                      defaultValue={defaultActiveWsId}
                      className="w-full border border-slate-200 rounded px-2 py-1.5"
                    >
                      {writableWorkspaces.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span>Income / Salary Title</span>
                    <input
                      required
                      name="name"
                      placeholder="Net Monthly Salary"
                      className="w-full border border-slate-200 rounded px-2.5 py-1.5"
                    />
                  </label>
                </div>
                <div className="p-2.5 rounded-md bg-emerald-50/70 border border-emerald-200 space-y-2">
                  <label className="block space-y-1">
                    <span className="font-semibold text-emerald-950">{t.depositIntoAccountLabel}</span>
                    <select
                      name="accountId"
                      defaultValue={defaultAccountForWs(defaultActiveWsId)}
                      className="w-full border border-emerald-300 bg-white rounded px-2 py-1.5 font-medium"
                    >
                      <option value="">{t.noAccountLinkOption}</option>
                      {allAvailableAccounts.map((acc) => (
                        <option key={acc.id} value={acc.id}>
                          🏦 {acc.name} ({acc.institution} · {formatDisplayValue(acc.balanceMinor, { currency: acc.currency, privacyMode })})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-2 text-emerald-900 font-medium">
                    <input type="checkbox" name="markReceivedNow" defaultChecked />
                    <span>{t.creditIncomeNowLabel}</span>
                  </label>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <label className="space-y-1">
                    <span>Net Amount</span>
                    <input
                      required
                      type="number"
                      step="0.01"
                      name="amountMajor"
                      className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                    />
                  </label>
                  <label className="space-y-1">
                    <span>Currency</span>
                    <select
                      name="currency"
                      defaultValue={cur}
                      className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                    >
                      {(['GBP', 'EUR', 'PLN', 'USD', 'CHF'] as CurrencyCode[]).map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span>Cadence</span>
                    <select
                      name="cadence"
                      defaultValue="monthly"
                      className="w-full border border-slate-200 rounded px-2 py-1.5"
                    >
                      <option value="monthly">Monthly</option>
                      <option value="annual">Annual</option>
                    </select>
                  </label>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <label className="space-y-1">
                    <span>Payday (1-28)</span>
                    <input
                      type="number"
                      min={1}
                      max={28}
                      name="paydayDay"
                      defaultValue={27}
                      className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                    />
                  </label>
                  <label className="space-y-1">
                    <span>From</span>
                    <input
                      required
                      type="date"
                      name="effectiveFrom"
                      defaultValue={`${yearMonth}-01`}
                      className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                    />
                  </label>
                  <label className="space-y-1">
                    <span>To (blank = current)</span>
                    <input
                      type="date"
                      name="effectiveTo"
                      className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                    />
                  </label>
                </div>
                <button type="submit" className="w-full py-2 rounded bg-slate-900 text-white font-medium">
                  {t.qaSave}
                </button>
              </form>
            )}

            {modal.kind === 'account' && (
              <form
                className="space-y-3 text-xs"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  await apiFetch('/api/accounts', {
                    method: 'POST',
                    body: JSON.stringify({
                      workspaceId: fd.get('workspaceId'),
                      name: fd.get('name'),
                      institution: fd.get('institution'),
                      balanceMinor: Math.round(Number(fd.get('balanceMajor') || 0) * 100),
                      currency: fd.get('currency'),
                      isPrimaryRunway: fd.get('isPrimaryRunway') === 'on',
                      pocketMoneyTargetMinor: Math.round(Number(fd.get('pocketMoneyTargetMajor') || 0) * 100),
                      notes: String(fd.get('notes') || '').trim() || null,
                    }),
                  });
                  setModal(null);
                  await reloadAll();
                }}
              >
                <div className="grid grid-cols-2 gap-2.5">
                  <label className="space-y-1">
                    <span>Workspace</span>
                    <select
                      name="workspaceId"
                      defaultValue={defaultActiveWsId}
                      className="w-full border border-slate-200 rounded px-2 py-1.5"
                    >
                      {writableWorkspaces.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span>Bank / Institution</span>
                    <input
                      name="institution"
                      placeholder="Monzo, Starling, mBank..."
                      className="w-full border border-slate-200 rounded px-2 py-1.5"
                    />
                  </label>
                </div>
                <label className="block space-y-1">
                  <span>Account Name</span>
                  <input
                    required
                    name="name"
                    placeholder="Current Account"
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5"
                  />
                </label>
                <div className="grid grid-cols-2 gap-2.5">
                  <label className="space-y-1">
                    <span>Current Balance</span>
                    <input
                      required
                      type="number"
                      step="0.01"
                      name="balanceMajor"
                      className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                    />
                  </label>
                  <label className="space-y-1">
                    <span>Currency</span>
                    <select
                      name="currency"
                      defaultValue={cur}
                      className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                    >
                      {(['GBP', 'EUR', 'PLN', 'USD', 'CHF'] as CurrencyCode[]).map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="block space-y-1">
                  <span>🎯 Monthly Pocket Money Allowance (optional, 0 = none)</span>
                  <input
                    type="number"
                    step="1"
                    name="pocketMoneyTargetMajor"
                    defaultValue="0"
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5 font-mono-num"
                  />
                </label>
                <label className="block space-y-1">
                  <span>{t.notesInputLabel}</span>
                  <input
                    name="notes"
                    placeholder="Account owners, routing notes..."
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5"
                  />
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="isPrimaryRunway" defaultChecked />
                  <span>Include in monthly sufficiency runway check</span>
                </label>
                <button type="submit" className="w-full py-2 rounded bg-slate-900 text-white font-medium">
                  {t.qaSave}
                </button>
              </form>
            )}

            {modal.kind === 'transfer' &&
              (() => {
                const srcAcc = allAvailableAccounts.find((a) => a.id === transferSourceId);
                const dstAcc = allAvailableAccounts.find((a) => a.id === transferDestId);
                const singleAmountMinor = Math.max(0, Math.round(Number(transferAmountMajor || 0) * 100));
                const otherAccounts = allAvailableAccounts.filter((a) => a.id !== transferSourceId);
                const totalBatchMinor = otherAccounts.reduce((sum, acc) => {
                  const val = Math.max(0, Math.round(Number(transferBatchMap[acc.id] || 0) * 100));
                  return sum + val;
                }, 0);

                return (
                  <div className="space-y-3 text-xs">
                    {/* Mode Switcher: Single Transfer vs Salary Distribution */}
                    <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-slate-100 border border-slate-200">
                      <button
                        type="button"
                        onClick={() => setTransferMode('single')}
                        className={`py-1.5 px-2 rounded-md font-medium transition ${
                          transferMode === 'single'
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {t.singleTransferTab}
                      </button>
                      <button
                        type="button"
                        onClick={() => setTransferMode('distribute')}
                        className={`py-1.5 px-2 rounded-md font-medium transition ${
                          transferMode === 'distribute'
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {t.salaryDistTab}
                      </button>
                    </div>

                    {transferMode === 'single' ? (
                      <form
                        className="space-y-3"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          if (!transferSourceId || !transferDestId || transferSourceId === transferDestId) return;
                          if (singleAmountMinor <= 0) return;
                          setBusy(true);
                          try {
                            await createTransferApi({
                              sourceAccountId: transferSourceId,
                              destinationAccountId: transferDestId,
                              amountMinor: singleAmountMinor,
                              currency: srcAcc?.currency || cur,
                              transferDate,
                              transferTime,
                              description: transferDesc,
                              referenceNumber: transferRef || null,
                            });
                            setModal(null);
                            await reloadAll();
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                          <label className="space-y-1">
                            <span className="font-semibold text-rose-900">{t.fromAccountLabel}</span>
                            <select
                              required
                              value={transferSourceId}
                              onChange={(e) => {
                                const nextSrc = e.target.value;
                                setTransferSourceId(nextSrc);
                                if (nextSrc === transferDestId) {
                                  const alt = allAvailableAccounts.find((a) => a.id !== nextSrc)?.id || '';
                                  setTransferDestId(alt);
                                }
                              }}
                              className="w-full border border-rose-200 bg-rose-50/40 rounded px-2 py-1.5 font-medium"
                            >
                              {allAvailableAccounts.map((acc) => (
                                <option key={acc.id} value={acc.id}>
                                  🏦 {acc.name} ({formatDisplayValue(acc.balanceMinor, { currency: acc.currency, privacyMode })})
                                </option>
                              ))}
                            </select>
                          </label>

                          <label className="space-y-1">
                            <span className="font-semibold text-emerald-900">{t.toAccountLabel}</span>
                            <select
                              required
                              value={transferDestId}
                              onChange={(e) => setTransferDestId(e.target.value)}
                              className="w-full border border-emerald-200 bg-emerald-50/40 rounded px-2 py-1.5 font-medium"
                            >
                              {allAvailableAccounts
                                .filter((acc) => acc.id !== transferSourceId)
                                .map((acc) => (
                                  <option key={acc.id} value={acc.id}>
                                    🏦 {acc.name} ({formatDisplayValue(acc.balanceMinor, { currency: acc.currency, privacyMode })})
                                  </option>
                                ))}
                            </select>
                          </label>
                        </div>

                        <div className="grid grid-cols-3 gap-2">
                          <label className="space-y-1">
                            <span className="font-medium">{t.amountValueLabel}</span>
                            <input
                              required
                              type="number"
                              step="0.01"
                              min="0.01"
                              value={transferAmountMajor}
                              onChange={(e) => setTransferAmountMajor(e.target.value)}
                              placeholder="120.00"
                              className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                            />
                          </label>
                          <label className="space-y-1">
                            <span>Date</span>
                            <input
                              required
                              type="date"
                              value={transferDate}
                              onChange={(e) => setTransferDate(e.target.value)}
                              className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                            />
                          </label>
                          <label className="space-y-1">
                            <span>Time</span>
                            <input
                              type="time"
                              value={transferTime}
                              onChange={(e) => setTransferTime(e.target.value)}
                              className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                            />
                          </label>
                        </div>

                        {srcAcc && dstAcc && singleAmountMinor > 0 && (
                          <div className="p-2.5 rounded-md bg-slate-50 border border-slate-200 font-mono-num text-[11px] space-y-1">
                            <div className="flex justify-between text-rose-800">
                              <span>{srcAcc.name} after transfer:</span>
                              <span className="font-semibold">
                                {formatDisplayValue(srcAcc.balanceMinor, { currency: srcAcc.currency, privacyMode })} →{' '}
                                {formatDisplayValue(srcAcc.balanceMinor - singleAmountMinor, {
                                  currency: srcAcc.currency,
                                  privacyMode,
                                })}
                              </span>
                            </div>
                            <div className="flex justify-between text-emerald-800">
                              <span>{dstAcc.name} after transfer:</span>
                              <span className="font-semibold">
                                {formatDisplayValue(dstAcc.balanceMinor, { currency: dstAcc.currency, privacyMode })} →{' '}
                                {formatDisplayValue(dstAcc.balanceMinor + singleAmountMinor, {
                                  currency: dstAcc.currency,
                                  privacyMode,
                                })}
                              </span>
                            </div>
                          </div>
                        )}

                        <div className="grid grid-cols-2 gap-2">
                          <label className="space-y-1">
                            <span>{t.notesInputLabel}</span>
                            <input
                              value={transferDesc}
                              onChange={(e) => setTransferDesc(e.target.value)}
                              placeholder="e.g. Monthly bills transfer"
                              className="w-full border border-slate-200 rounded px-2.5 py-1.5"
                            />
                          </label>
                          <label className="space-y-1">
                            <span>{t.refPolicyInputLabel}</span>
                            <input
                              value={transferRef}
                              onChange={(e) => setTransferRef(e.target.value)}
                              placeholder="Optional reference"
                              className="w-full border border-slate-200 rounded px-2.5 py-1.5 font-mono-num"
                            />
                          </label>
                        </div>

                        <button
                          type="submit"
                          disabled={busy || singleAmountMinor <= 0 || !transferSourceId || !transferDestId}
                          className="w-full py-2 rounded bg-teal-700 text-white font-medium hover:bg-teal-800 disabled:opacity-50 transition"
                        >
                          {t.executeTransferBtn}
                        </button>
                      </form>
                    ) : (
                      <form
                        className="space-y-3"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          const allocations = otherAccounts
                            .map((acc) => ({
                              destinationAccountId: acc.id,
                              amountMinor: Math.max(0, Math.round(Number(transferBatchMap[acc.id] || 0) * 100)),
                              description: transferDesc || `Salary distribution to ${acc.name}`,
                            }))
                            .filter((a) => a.amountMinor > 0);
                          if (!transferSourceId || allocations.length === 0) return;
                          setBusy(true);
                          try {
                            await createTransferBatchApi({
                              sourceAccountId: transferSourceId,
                              transferDate,
                              transferTime,
                              description: transferDesc || 'Salary distribution',
                              allocations,
                            });
                            setModal(null);
                            await reloadAll();
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        <div className="flex flex-wrap items-end justify-between gap-2">
                          <label className="flex-1 min-w-[200px] space-y-1">
                            <span className="font-semibold text-rose-900">{t.fromAccountLabel} (Salary Source)</span>
                            <select
                              value={transferSourceId}
                              onChange={(e) => setTransferSourceId(e.target.value)}
                              className="w-full border border-rose-200 bg-rose-50/40 rounded px-2 py-1.5 font-medium"
                            >
                              {allAvailableAccounts.map((acc) => (
                                <option key={acc.id} value={acc.id}>
                                  🏦 {acc.name} ({formatDisplayValue(acc.balanceMinor, { currency: acc.currency, privacyMode })})
                                </option>
                              ))}
                            </select>
                          </label>
                          <button
                            type="button"
                            onClick={() => {
                              const nextMap: Record<string, string> = { ...transferBatchMap };
                              for (const acc of otherAccounts) {
                                const stat = (budget.accountAnalytics || []).find((s) => s.accountId === acc.id);
                                if (stat && !stat.isPrePaydaySufficient && stat.netPrePaydayNativeMinor < 0) {
                                  nextMap[acc.id] = (Math.abs(stat.netPrePaydayNativeMinor) / 100).toFixed(2);
                                }
                              }
                              setTransferBatchMap(nextMap);
                            }}
                            className="px-2.5 py-1.5 rounded border border-teal-300 bg-teal-50 text-teal-900 text-[11px] font-medium hover:bg-teal-100 transition"
                          >
                            ⚡ {t.autoFillShortfallsBtn}
                          </button>
                        </div>

                        <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-[240px] overflow-y-auto">
                          {otherAccounts.map((acc) => {
                            const stat = (budget.accountAnalytics || []).find((s) => s.accountId === acc.id);
                            const addMinor = Math.max(0, Math.round(Number(transferBatchMap[acc.id] || 0) * 100));
                            const shortfallMinor =
                              stat && !stat.isPrePaydaySufficient && stat.netPrePaydayNativeMinor < 0
                                ? Math.abs(stat.netPrePaydayNativeMinor)
                                : 0;
                            return (
                              <div key={acc.id} className="p-2.5 flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="font-medium text-slate-800 truncate">{acc.name}</div>
                                  <div className="text-[10.5px] font-mono-num text-slate-500">
                                    Now: {formatDisplayValue(acc.balanceMinor, { currency: acc.currency, privacyMode })}
                                    {addMinor > 0 && (
                                      <span className="text-emerald-700 font-semibold">
                                        {' '}
                                        → {formatDisplayValue(acc.balanceMinor + addMinor, { currency: acc.currency, privacyMode })}
                                      </span>
                                    )}
                                    {shortfallMinor > 0 && (
                                      <span className="text-amber-700">
                                        {' '}
                                        · Shortfall:{' '}
                                        {formatDisplayValue(shortfallMinor, { currency: acc.currency, privacyMode })}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div className="w-28 shrink-0">
                                  <input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    value={transferBatchMap[acc.id] || ''}
                                    onChange={(e) =>
                                      setTransferBatchMap((prev) => ({ ...prev, [acc.id]: e.target.value }))
                                    }
                                    placeholder="0.00"
                                    className="w-full border border-slate-200 rounded px-2 py-1 text-right font-mono-num"
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {srcAcc && (
                          <div className="p-2.5 rounded-md bg-slate-50 border border-slate-200 font-mono-num text-[11px] flex items-center justify-between">
                            <span>
                              Total Distributed:{' '}
                              <strong className="text-slate-900">
                                {formatDisplayValue(totalBatchMinor, { currency: srcAcc.currency, privacyMode })}
                              </strong>
                            </span>
                            <span className={srcAcc.balanceMinor - totalBatchMinor < 0 ? 'text-rose-700 font-semibold' : 'text-teal-900'}>
                              Remaining on {srcAcc.name.split('—')[0].trim()}:{' '}
                              <strong>
                                {formatDisplayValue(srcAcc.balanceMinor - totalBatchMinor, {
                                  currency: srcAcc.currency,
                                  privacyMode,
                                })}
                              </strong>
                            </span>
                          </div>
                        )}

                        <div className="grid grid-cols-2 gap-2">
                          <label className="space-y-1">
                            <span>Date</span>
                            <input
                              required
                              type="date"
                              value={transferDate}
                              onChange={(e) => setTransferDate(e.target.value)}
                              className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num"
                            />
                          </label>
                          <label className="space-y-1">
                            <span>{t.notesInputLabel}</span>
                            <input
                              value={transferDesc}
                              onChange={(e) => setTransferDesc(e.target.value)}
                              placeholder="Salary distribution"
                              className="w-full border border-slate-200 rounded px-2.5 py-1.5"
                            />
                          </label>
                        </div>

                        <button
                          type="submit"
                          disabled={busy || totalBatchMinor <= 0}
                          className="w-full py-2 rounded bg-teal-700 text-white font-medium hover:bg-teal-800 disabled:opacity-50 transition"
                        >
                          {t.executeDistributionBtn}
                        </button>
                      </form>
                    )}
                  </div>
                );
              })()}
          </div>
        </div>
      )}
    </div>
  );
};
