import {
  Check,
  CheckCircle2,
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
  KeyRound,
  Landmark,
  LogOut,
  Paperclip,
  PiggyBank,
  Plus,
  RefreshCw,
  Shield,
  Sparkles,
  Trash2,
  TrendingDown,
  TrendingUp,
  Upload,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CURRENCY_SYMBOLS, formatDisplayValue, formatIndexedWealth } from '../shared/currency.js';
import type {
  AttachmentRecord,
  CurrencyCode,
  PartnerVisibility,
  PotRollupNode,
  SplitMode,
} from '../shared/types.js';
import {
  type AuthStatusResponse,
  type BootstrapResponse,
  type BudgetMonthResponse,
  type EnrichedObligation,
  type WealthOverviewResponse,
  apiFetch,
  listAttachmentsApi,
} from './api.js';
import {
  CashflowSankeyChart,
  DailyRunwayChart,
  PotProportionStrip,
  SixMonthTrendChart,
  WealthHorizonChart,
} from './charts.js';

type TabKey = 'overview' | 'timeline' | 'pots' | 'wealth' | 'settings';

type ModalKind =
  | null
  | { kind: 'obligation' }
  | { kind: 'expense' }
  | { kind: 'pot' }
  | { kind: 'income' }
  | { kind: 'account' }
  | { kind: 'asset' }
  | { kind: 'liability' };

interface DrawerSubject {
  entityType: 'obligation' | 'expense' | 'asset' | 'liability';
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
  const nm = (total % 12) + 1;
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
  return `Connect to my **Skyday Finance & Budget** MCP server so you can read my spending pots, check monthly budgets, categorize receipt photos/invoices, and tick scheduled bills as paid.

### 1. Connection & Credentials
- **MCP Endpoint (Streamable HTTP / JSON-RPC 2.0 \`POST\`):** \`${mcpUrl}\`
- **Attachment Upload Endpoint (Multipart \`POST\`):** \`${attachUrl}\`
- **Authorization Header:** \`Authorization: Bearer ${params.token}\`
- **Authenticated Account:** ${params.displayName} (Default currency: \`${params.defaultCurrency}\`)
- **Workspaces:** \`ws-home\` (Shared Household) and \`${params.personalWorkspaceId}\` (${params.displayName} Personal)

> Security rule: Store this Bearer token in your secret file or local \`mcp_config.json\` (mode 0600); never commit it to Git or echo it into public reports.

### 2. Register in \`mcp_config.json\`
If your client supports Streamable HTTP MCP with headers:
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
*(If your MCP host uses Stdio without custom HTTP header support, use \`mcp-remote\`):*
\`\`\`json
{
  "mcpServers": {
    "skyday-finance": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "${mcpUrl}",
        "--header",
        "Authorization: Bearer ${params.token}"
      ]
    }
  }
}
\`\`\`

### 3. Direct JSON-RPC 2.0 Handshake & Tools (Works Immediately via HTTP \`POST\`)
Even before restarting your MCP host, you can call \`${mcpUrl}\` directly via HTTP \`POST\` with \`Content-Type: application/json\` and \`Authorization: Bearer ${params.token}\`:

1. **Discover Pots (\`list_pots\`):** Always call \`list_pots\` first to map a receipt/invoice to the right nested pot ID (e.g. \`Home & Utilities -> Food & Groceries -> Butcher & Meat\`, \`Car & Moto Fleet -> Fuel\`).
2. **Log Categorized Receipt (\`log_expense_receipt\`):** Pass \`workspaceId\` (\`ws-home\` or \`${params.personalWorkspaceId}\`), \`potId\`, \`merchant\`, \`amountMajor\`, \`currency\` (\`GBP\`|\`EUR\`|\`PLN\`|\`USD\`|\`CHF\`), \`spentDate\` (\`YYYY-MM-DD\`), and optional itemized \`items: [{ name, subCategory, amountMajor }]\`. Returns \`expenseId\`.
3. **Attach Receipt Photo / PDF (\`attach_receipt_base64\`):** Pass \`entityType: "expense"\`, \`entityId: "<expenseId>"\`, \`workspaceId\`, \`fileName\`, \`mimeType\`, and \`dataBase64\` to store the receipt image/PDF in the Skyday Finance vault.
4. **Budget & Bills (\`get_monthly_budget\`, \`list_upcoming_obligations\`, \`mark_obligation_paid\`):** Query monthly budget/Preserve sinking-fund status or mark a bill paid.

Verify connection now by calling \`tools/list\` against \`${mcpUrl}\`:
\`\`\`bash
curl -sS -X POST "${mcpUrl}" \\
  -H "Authorization: Bearer ${params.token}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
\`\`\``;
}

export const App: React.FC = () => {
  const [auth, setAuth] = useState<AuthStatusResponse | null>(null);
  const [boot, setBoot] = useState<BootstrapResponse | null>(null);
  const [budget, setBudget] = useState<BudgetMonthResponse | null>(null);
  const [wealth, setWealth] = useState<WealthOverviewResponse | null>(null);

  const [tab, setTab] = useState<TabKey>('overview');
  const [yearMonth, setYearMonth] = useState<string>(() => new Date().toISOString().slice(0, 7));
  const [scope, setScope] = useState<'all' | 'shared' | 'personal'>('all');
  const [horizonYears, setHorizonYears] = useState<number>(10);
  const [wealthMode, setWealthMode] = useState<'combined' | 'mine'>('combined');
  const [selectedPotId, setSelectedPotId] = useState<string | null>(null);

  const [privacyMode, setPrivacyMode] = useState<boolean>(() => {
    return localStorage.getItem('skyday_privacy_mode') === '1';
  });

  const [modal, setModal] = useState<ModalKind>(null);
  const [drawer, setDrawer] = useState<DrawerSubject | null>(null);
  const [drawerAttachments, setDrawerAttachments] = useState<AttachmentRecord[]>([]);
  const [newlyMintedKey, setNewlyMintedKey] = useState<string | null>(null);
  const [agentKeyLabel, setAgentKeyLabel] = useState<string>('');
  const [copiedNotice, setCopiedNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const togglePrivacy = useCallback(() => {
    setPrivacyMode((prev) => {
      const next = !prev;
      localStorage.setItem('skyday_privacy_mode', next ? '1' : '0');
      return next;
    });
  }, []);

  // Keyboard shortcut 'P' for Friends %-Only Privacy Mode
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
      if (!st.authenticated) return;

      const [b, m, w] = await Promise.all([
        apiFetch<BootstrapResponse>('/api/bootstrap'),
        apiFetch<BudgetMonthResponse>(`/api/budget/month?ym=${yearMonth}&scope=${scope}`),
        apiFetch<WealthOverviewResponse>(`/api/wealth/overview?horizon=${horizonYears}`),
      ]);
      setBoot(b);
      setBudget(m);
      setWealth(w);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load data');
    }
  }, [yearMonth, scope, horizonYears]);

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

  const flatPots = useMemo(() => {
    if (!budget) return [];
    const out: Array<{ node: PotRollupNode; depth: number }> = [];
    const walk = (nodes: PotRollupNode[], depth: number) => {
      for (const n of nodes) {
        out.push({ node: n, depth });
        walk(n.children, depth + 1);
      }
    };
    walk(budget.potTree, 0);
    return out;
  }, [budget]);

  // --- Unauthenticated SSO Gate ---
  if (auth && !auth.authenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-[#FAF9F6]">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-xl p-8 shadow-xs space-y-6">
          <div className="space-y-1">
            <div className="text-xs font-mono-num uppercase tracking-widest text-teal-700 font-semibold">
              SKYDAY · HOMELAB
            </div>
            <h1 className="text-2xl font-semibold text-slate-900">Finance & Wealth</h1>
            <p className="text-sm text-slate-500">
              Personal & shared household budgeting, automatic sinking-fund reserves, and long-horizon wealth analytics.
            </p>
          </div>

          <a
            href={auth.loginUrl}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 transition"
          >
            <Shield className="w-4 h-4 text-teal-400" />
            Sign in with Authentik SSO
          </a>

          <div className="text-[11px] text-slate-400 font-mono-num text-center">
            Protected by SKYDAY Authentik · Named accounts: Wadera & Walter
          </div>
        </div>
      </div>
    );
  }

  if (!boot || !budget || !wealth) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-slate-500 font-mono-num">
        Loading Skyday Finance…
      </div>
    );
  }

  const writableWorkspaces = boot.workspaces.filter((w) => w.canWrite);
  const myPersonalWs = boot.workspaces.find((w) => w.id === boot.user.personalWorkspaceId);
  const sharedWs = boot.workspaces.find((w) => w.id === 'ws-home');

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

  const handleDepositPreserve = async (ob: EnrichedObligation) => {
    if (ob.metrics.monthlyPreserveNativeMinor <= 0) return;
    setBusy(true);
    try {
      await apiFetch(`/api/obligations/${ob.id}/toggle-paid`, {
        method: 'POST',
        body: JSON.stringify({
          yearMonth,
          preserveDepositMinor: ob.metrics.monthlyPreserveNativeMinor,
        }),
      });
      await reloadAll();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#FAF9F6] text-slate-800">
      {/* Editorial Top Bar */}
      <header className="sticky top-0 z-20 bg-[#FAF9F6]/95 backdrop-blur border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-5">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-xs bg-teal-700" />
              <span className="font-mono-num text-sm font-semibold tracking-tight text-slate-900">
                SKYDAY · FINANCE
              </span>
            </div>

            <nav className="hidden md:flex items-center gap-1">
              {(
                [
                  ['overview', 'Overview'],
                  ['timeline', 'Timeline'],
                  ['pots', 'Pots'],
                  ['wealth', 'Wealth'],
                  ['settings', 'Settings'],
                ] as Array<[TabKey, string]>
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setTab(k)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${
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

          <div className="flex items-center gap-2">
            {/* Month switcher */}
            {tab !== 'wealth' && tab !== 'settings' && (
              <div className="inline-flex items-center border border-slate-200 bg-white rounded-md text-xs font-mono-num">
                <button
                  type="button"
                  onClick={() => setYearMonth((ym) => shiftMonth(ym, -1))}
                  className="p-1.5 text-slate-500 hover:text-slate-900"
                  title="Previous month"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <span className="px-2 font-medium text-slate-800">{yearMonth}</span>
                <button
                  type="button"
                  onClick={() => setYearMonth((ym) => shiftMonth(ym, 1))}
                  className="p-1.5 text-slate-500 hover:text-slate-900"
                  title="Next month"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* Scope switcher */}
            {tab !== 'wealth' && tab !== 'settings' && (
              <div className="hidden sm:inline-flex border border-slate-200 bg-white rounded-md p-0.5 text-xs">
                {(
                  [
                    ['all', 'All'],
                    ['shared', 'Home'],
                    ['personal', 'Personal'],
                  ] as const
                ).map(([sc, lbl]) => (
                  <button
                    key={sc}
                    type="button"
                    onClick={() => setScope(sc)}
                    className={`px-2 py-1 rounded text-[11px] font-medium transition ${
                      scope === sc ? 'bg-slate-800 text-white' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            )}

            {/* Friends %-Only Privacy Shield Toggle */}
            <button
              type="button"
              onClick={togglePrivacy}
              title="Toggle Friends %-Only Privacy View (Shortcut: P)"
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs font-mono-num transition ${
                privacyMode
                  ? 'border-teal-700 bg-teal-700 text-white'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
              }`}
            >
              {privacyMode ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              <span>{privacyMode ? '% ONLY' : cur}</span>
            </button>

            {/* User Badge / Dev Switcher */}
            {auth?.authMode === 'dev' && auth.devUsers ? (
              <select
                value={boot.user.handle}
                onChange={async (e) => {
                  await apiFetch('/api/auth/dev-switch', {
                    method: 'POST',
                    body: JSON.stringify({ handle: e.target.value }),
                  });
                  await reloadAll();
                }}
                className="border border-slate-200 bg-white rounded-md px-2 py-1 text-xs font-medium text-slate-700"
              >
                {auth.devUsers.map((u) => (
                  <option key={u.handle} value={u.handle}>
                    {u.displayName} (dev)
                  </option>
                ))}
              </select>
            ) : (
              <div className="inline-flex items-center gap-1.5 pl-2 text-xs text-slate-600">
                <span className="font-medium text-slate-800">{boot.user.displayName}</span>
                <button
                  type="button"
                  title="Sign out"
                  onClick={async () => {
                    const r = await apiFetch<{ endSessionUrl: string }>('/api/auth/logout', { method: 'POST' });
                    window.location.href = r.endSessionUrl || '/';
                  }}
                  className="p-1 text-slate-400 hover:text-slate-700"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Mobile Tab Strip */}
        <div className="flex md:hidden border-t border-slate-200 px-3 py-1.5 gap-1 overflow-x-auto">
          {(['overview', 'timeline', 'pots', 'wealth', 'settings'] as TabKey[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`px-2.5 py-1 rounded text-xs capitalize ${
                tab === k ? 'bg-slate-900 text-white' : 'text-slate-600'
              }`}
            >
              {k}
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
            {/* KPI Strip */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="bg-white border border-slate-200 rounded-lg p-4">
                <div className="text-[11px] font-mono-num uppercase tracking-wider text-slate-400">
                  Monthly Income
                </div>
                <div className="mt-1 text-2xl font-mono-num font-semibold text-slate-900">
                  {privacyMode ? '100.0%' : fmt(budget.kpis.totalIncomeMinor)}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {budget.incomes.length} active stream{budget.incomes.length === 1 ? '' : 's'}
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-lg p-4">
                <div className="text-[11px] font-mono-num uppercase tracking-wider text-slate-400">
                  Planned & Spent
                </div>
                <div className="mt-1 text-2xl font-mono-num font-semibold text-slate-900">
                  {fmt(budget.kpis.potPlannedTotalMinor)}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Bills, envelopes & receipts
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-lg p-4">
                <div className="text-[11px] font-mono-num uppercase tracking-wider text-teal-700">
                  Auto-Preserve (Sinking)
                </div>
                <div className="mt-1 text-2xl font-mono-num font-semibold text-teal-800">
                  {fmt(budget.kpis.totalPreserveSliceMinor)}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Set aside this month for future bills
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-lg p-4">
                <div className="text-[11px] font-mono-num uppercase tracking-wider text-slate-400">
                  Unallocated Surplus
                </div>
                <div
                  className={`mt-1 text-2xl font-mono-num font-semibold ${
                    budget.kpis.netMonthlySurplusMinor >= 0 ? 'text-emerald-700' : 'text-amber-700'
                  }`}
                >
                  {fmt(budget.kpis.netMonthlySurplusMinor)}
                </div>
                <div className="mt-1 text-xs text-slate-500 font-mono-num">
                  Savings rate: {budget.kpis.savingsRatePct}%
                </div>
              </div>
            </div>

            {/* Cashflow Sankey Card */}
            <section className="bg-white border border-slate-200 rounded-lg p-5">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div>
                  <h2 className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                    Where the Money Goes · Cashflow Routing
                  </h2>
                  <p className="text-xs text-slate-400">
                    Income streams → monthly budget pool → pots, sinking reserves & unallocated savings
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setModal({ kind: 'expense' })}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Plus className="w-3.5 h-3.5" /> Expense
                  </button>
                  <button
                    type="button"
                    onClick={() => setModal({ kind: 'obligation' })}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-slate-900 text-white text-xs font-medium hover:bg-slate-800"
                  >
                    <Plus className="w-3.5 h-3.5" /> Scheduled Bill / Goal
                  </button>
                </div>
              </div>

              <CashflowSankeyChart
                nodes={budget.sankey.nodes}
                links={budget.sankey.links}
                currency={cur}
                privacyMode={privacyMode}
                referenceIncomeMinor={budget.kpis.totalIncomeMinor}
              />
            </section>

            {/* Bottom 2-column brief summary: 6-Month Trend + Active Sinking Reserves */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <section className="bg-white border border-slate-200 rounded-lg p-5">
                <div className="flex items-center justify-between mb-1">
                  <h3 className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                    6-Month Income vs. Spend
                  </h3>
                  <span className="text-[11px] font-mono-num text-slate-400">Teal = Income · Slate = Spend</span>
                </div>
                <SixMonthTrendChart data={budget.trend6m} currency={cur} privacyMode={privacyMode} />
              </section>

              <section className="bg-white border border-slate-200 rounded-lg p-5 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                      Upcoming Sinking-Fund ("Preserve") Goals
                    </h3>
                    <PiggyBank className="w-4 h-4 text-teal-700" />
                  </div>
                  <div className="space-y-2.5">
                    {budget.obligations
                      .filter((o) => !o.metrics.isDueThisMonth && o.preserveDisplayMinor > 0)
                      .slice(0, 5)
                      .map((ob) => {
                        const progressPct =
                          ob.amountMinor > 0 ? Math.min(100, Math.round((ob.preservedMinor / ob.amountMinor) * 100)) : 0;
                        return (
                          <div key={ob.id} className="border border-slate-100 rounded-md p-2.5 bg-[#FAF9F6]/60">
                            <div className="flex items-center justify-between text-xs">
                              <span className="font-medium text-slate-800">{ob.name}</span>
                              <span className="font-mono-num font-semibold text-teal-800">
                                +{fmt(ob.preserveDisplayMinor)}/mo
                              </span>
                            </div>
                            <div className="flex items-center justify-between text-[11px] text-slate-500 mt-1 font-mono-num">
                              <span>
                                Due {ob.nextDueDate} ({ob.metrics.monthsUntilDue}m left)
                              </span>
                              <span>
                                Preserved {progressPct}%{' '}
                                {!privacyMode && `(${fmt(ob.preservedDisplayMinor)} / ${fmt(ob.targetDisplayMinor)})`}
                              </span>
                            </div>
                            <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden mt-1.5">
                              <div className="h-full bg-teal-700" style={{ width: `${progressPct}%` }} />
                            </div>
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
            {/* Sufficiency Banner + Runway Curve */}
            <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block w-2.5 h-2.5 rounded-full ${
                        budget.runway.isSufficient ? 'bg-emerald-600' : 'bg-amber-600'
                      }`}
                    />
                    <h2 className="text-sm font-semibold text-slate-900">
                      {budget.runway.isSufficient
                        ? 'Account Runway Sufficient Through Month-End'
                        : 'Additional Funds Needed Before Month-End'}
                    </h2>
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5 font-mono-num">
                    Runway cash: {fmt(budget.runway.runwayCashMinor)} · Unpaid due:{' '}
                    {fmt(budget.runway.unpaidBillsMinor)} · Preserve transfers:{' '}
                    {fmt(budget.runway.totalPreserveSliceMinor)} · Remaining envelopes:{' '}
                    {fmt(budget.runway.unallocatedEnvelopeRemainingMinor)}
                  </p>
                </div>

                <div className="text-right font-mono-num">
                  <div className="text-[11px] uppercase text-slate-400">
                    {budget.runway.isSufficient ? 'Projected Month-End Buffer' : 'Required Top-Up'}
                  </div>
                  <div
                    className={`text-xl font-semibold ${
                      budget.runway.isSufficient ? 'text-emerald-700' : 'text-amber-700'
                    }`}
                  >
                    {budget.runway.isSufficient
                      ? fmt(budget.runway.projectedEndBalanceMinor)
                      : fmt(budget.runway.shortfallMinor)}
                  </div>
                </div>
              </div>

              <DailyRunwayChart
                curve={budget.runway.dailyCurve}
                currency={cur}
                privacyMode={privacyMode}
              />
            </section>

            {/* Chronological Monthly Checklist */}
            <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-mono-num uppercase tracking-wider text-slate-600 font-semibold">
                    Monthly Payment Checklist & Sinking Accruals ({yearMonth})
                  </h3>
                  <p className="text-xs text-slate-400">
                    Tick bills as paid to update live account sufficiency; multi-month bills automatically reset Preserve upon payment.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setModal({ kind: 'obligation' })}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-slate-900 text-white text-xs font-medium"
                >
                  <Plus className="w-3.5 h-3.5" /> Add Scheduled Payment
                </button>
              </div>

              <div className="divide-y divide-slate-100">
                {budget.obligations.map((ob) => {
                  const isDueNow = ob.metrics.isDueThisMonth;
                  return (
                    <div
                      key={ob.id}
                      className={`px-5 py-3 flex flex-wrap items-center justify-between gap-3 hover:bg-slate-50/70 ${
                        ob.isPaidThisMonth ? 'opacity-65' : ''
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleTogglePaid(ob)}
                          className="text-slate-400 hover:text-teal-700 transition"
                          title={ob.isPaidThisMonth ? 'Mark as unpaid' : 'Mark as paid'}
                        >
                          {ob.isPaidThisMonth ? (
                            <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                          ) : (
                            <Circle className="w-5 h-5" />
                          )}
                        </button>
                        <div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                setDrawer({
                                  entityType: 'obligation',
                                  entityId: ob.id,
                                  workspaceId: ob.workspaceId,
                                  title: ob.name,
                                  subtitle: `${ob.cadence} · Next due ${ob.nextDueDate}`,
                                  manageUrl: ob.manageUrl,
                                  portalUrl: ob.portalUrl,
                                  referenceNumber: ob.referenceNumber,
                                  notes: ob.notes,
                                  currency: ob.currency,
                                })
                              }
                              className={`text-sm font-medium text-left hover:underline ${
                                ob.isPaidThisMonth ? 'line-through text-slate-500' : 'text-slate-900'
                              }`}
                            >
                              {ob.name}
                            </button>
                            <span className="text-[10px] font-mono-num px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                              {ob.workspaceId === 'ws-home' ? 'Shared' : 'Personal'}
                            </span>
                            {ob.currency !== cur && !privacyMode && (
                              <span className="text-[10px] font-mono-num px-1.5 py-0.5 rounded bg-amber-50 text-amber-800">
                                {ob.currency}
                              </span>
                            )}
                            {ob.manageUrl && (
                              <a
                                href={ob.manageUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-teal-700 hover:text-teal-900 inline-flex items-center gap-0.5 text-[11px]"
                                title="Manage / Cancel Portal"
                              >
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                          </div>
                          <div className="text-xs text-slate-500 font-mono-num">
                            {isDueNow
                              ? `Due ${yearMonth}-${String(ob.dueDay).padStart(2, '0')} · ${ob.cadence}`
                              : `Future (${ob.nextDueDate}, ${ob.metrics.monthsUntilDue}m away) · Sinking Preserve`}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 font-mono-num">
                        {!isDueNow && ob.preserveDisplayMinor > 0 && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleDepositPreserve(ob)}
                            className="px-2 py-1 rounded border border-teal-200 bg-teal-50 text-teal-800 text-[11px] hover:bg-teal-100"
                            title="Add this month's Preserve slice to saved reserve"
                          >
                            + Preserve {fmt(ob.preserveDisplayMinor)}
                          </button>
                        )}
                        <div className="text-right">
                          <div className="text-sm font-semibold text-slate-900">
                            {isDueNow ? fmt(ob.dueDisplayMinor) : `${fmt(ob.preserveDisplayMinor)}/mo`}
                          </div>
                          {!isDueNow && !privacyMode && (
                            <div className="text-[10px] text-slate-400">
                              Target {fmt(ob.targetDisplayMinor)}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </>
        )}

        {/* ======================== TAB 3: POTS, ENVELOPES & VAULT ======================== */}
        {tab === 'pots' && (
          <>
            <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                    Proportional Pot Allocation
                  </h2>
                  <p className="text-xs text-slate-400">
                    Click a pot to filter; supports rough monthly envelopes (e.g. £600 Food) alongside detailed sub-pot receipts without double counting.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setModal({ kind: 'pot' })}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <FolderTree className="w-3.5 h-3.5" /> New Pot / Sub-Pot
                  </button>
                  <button
                    type="button"
                    onClick={() => setModal({ kind: 'expense' })}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-slate-900 text-white text-xs font-medium"
                  >
                    <Plus className="w-3.5 h-3.5" /> Log Spend / Receipt
                  </button>
                </div>
              </div>

              <PotProportionStrip
                nodes={budget.potTree}
                currency={cur}
                privacyMode={privacyMode}
                selectedPotId={selectedPotId}
                onSelectPot={setSelectedPotId}
              />
            </section>

            {/* Hierarchical Pots Table */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-200 text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                  Nested Pots & Envelopes
                </div>
                <div className="divide-y divide-slate-100">
                  {flatPots.map(({ node, depth }) => (
                    <div
                      key={node.pot.id}
                      onClick={() => setSelectedPotId((curId) => (curId === node.pot.id ? null : node.pot.id))}
                      className={`px-4 py-2.5 flex items-center justify-between text-xs cursor-pointer hover:bg-slate-50 ${
                        selectedPotId === node.pot.id ? 'bg-slate-100/80' : ''
                      }`}
                    >
                      <div className="flex items-center gap-2" style={{ paddingLeft: `${depth * 18}px` }}>
                        <span className="w-2.5 h-2.5 rounded-xs" style={{ backgroundColor: node.pot.color }} />
                        <span className="font-medium text-slate-800">{node.pot.name}</span>
                        {node.pot.envelopeMode && (
                          <span className="text-[10px] font-mono-num px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800">
                            Envelope
                          </span>
                        )}
                      </div>
                      <div className="text-right font-mono-num">
                        <div className="font-semibold text-slate-900">{fmt(node.effectiveTotalDisplayMinor)}</div>
                        {node.pot.envelopeMode && node.unallocatedEnvelopeDisplayMinor > 0 && (
                          <div className="text-[10px] text-slate-400">
                            {fmt(node.itemizedSpendDisplayMinor)} logged · {fmt(node.unallocatedEnvelopeDisplayMinor)} est. left
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {/* Itemized Receipts & Portal-Linked Items */}
              <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                  <span className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                    Logged Receipts & Actionable Bills
                  </span>
                  {selectedPotId && (
                    <button
                      type="button"
                      onClick={() => setSelectedPotId(null)}
                      className="text-[11px] text-teal-700 hover:underline"
                    >
                      Clear filter
                    </button>
                  )}
                </div>
                <div className="divide-y divide-slate-100 max-h-[420px] overflow-y-auto">
                  {budget.expenses
                    .filter((e) => !selectedPotId || e.potId === selectedPotId)
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
                                ({exp.items.length} sub-items)
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {exp.spentDate} · {exp.description || 'Expense'}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 font-mono-num text-xs font-semibold text-slate-800">
                          <span>
                            {privacyMode
                              ? fmt(exp.amountMinor)
                              : `${CURRENCY_SYMBOLS[exp.currency]}${(exp.amountMinor / 100).toFixed(2)}`}
                          </span>
                          <Paperclip className="w-3.5 h-3.5 text-slate-400" />
                        </div>
                      </div>
                    ))}

                  {budget.obligations
                    .filter((o) => !selectedPotId || o.potId === selectedPotId)
                    .map((ob) => (
                      <div
                        key={ob.id}
                        onClick={() =>
                          setDrawer({
                            entityType: 'obligation',
                            entityId: ob.id,
                            workspaceId: ob.workspaceId,
                            title: ob.name,
                            subtitle: `${ob.cadence} · Next due ${ob.nextDueDate}`,
                            manageUrl: ob.manageUrl,
                            portalUrl: ob.portalUrl,
                            referenceNumber: ob.referenceNumber,
                            notes: ob.notes,
                            currency: ob.currency,
                          })
                        }
                        className="px-4 py-3 flex items-center justify-between hover:bg-slate-50 cursor-pointer"
                      >
                        <div>
                          <div className="flex items-center gap-2 text-xs font-medium text-slate-900">
                            <span>{ob.name}</span>
                            {ob.manageUrl && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-50 text-teal-800 font-mono-num">
                                Portal Link
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500 font-mono-num">
                            {ob.cadence} · Due {ob.nextDueDate}
                          </div>
                        </div>
                        <div className="font-mono-num text-xs font-semibold text-slate-700">
                          {fmt(ob.effectiveDisplayMinor)}/mo
                        </div>
                      </div>
                    ))}
                </div>
              </section>
            </div>
          </>
        )}

        {/* ======================== TAB 4: WEALTH & BELONGINGS ======================== */}
        {tab === 'wealth' && (
          <>
            {/* Separate vs Combined Family Wealth Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <button
                type="button"
                onClick={() => setWealthMode('mine')}
                className={`text-left bg-white border rounded-lg p-4 transition ${
                  wealthMode === 'mine' ? 'border-slate-900 ring-1 ring-slate-900' : 'border-slate-200'
                }`}
              >
                <div className="text-[11px] font-mono-num uppercase tracking-wider text-slate-400">
                  {boot.user.displayName} Net Worth (Incl. 50% Home)
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
                  Assets {fmt(wealth.myWealth.totalAssetsMinor, wealth.myWealth.totalAssetsMinor || 1, true)} · Debt{' '}
                  {fmt(wealth.myWealth.totalLiabilitiesMinor, wealth.myWealth.totalAssetsMinor || 1, true)}
                </div>
              </button>

              <div className="bg-white border border-slate-200 rounded-lg p-4">
                <div className="text-[11px] font-mono-num uppercase tracking-wider text-slate-400">
                  Partner Wealth ({wealth.partnerWealth.visibility})
                </div>
                <div className="mt-1 text-2xl font-mono-num font-semibold text-slate-800">
                  {wealth.partnerWealth.netWorthMinor != null
                    ? formatIndexedWealth(
                        wealth.partnerWealth.netWorthMinor,
                        wealth.combinedFamilyWealth.netWorthMinor || 1,
                        cur,
                        privacyMode
                      )
                    : 'Private'}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {wealth.partnerWealth.visibility === 'private'
                    ? 'Partner personal workspace is set to strictly private'
                    : wealth.partnerWealth.visibility === 'totals_only'
                    ? 'Aggregate total included; personal items hidden'
                    : 'Shared read-only'}
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
                  Combined Family Wealth
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
                  Assets{' '}
                  {fmt(
                    wealth.combinedFamilyWealth.totalAssetsMinor,
                    wealth.combinedFamilyWealth.totalAssetsMinor || 1,
                    true
                  )}{' '}
                  · Mortgages/Loans{' '}
                  {fmt(
                    wealth.combinedFamilyWealth.totalLiabilitiesMinor,
                    wealth.combinedFamilyWealth.totalAssetsMinor || 1,
                    true
                  )}
                </div>
              </button>
            </div>

            {/* Long-Horizon Forecast Graph */}
            <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                    {wealthMode === 'combined' ? 'Combined Family' : boot.user.displayName} Net Worth Trajectory &{' '}
                    {horizonYears}-Year Forecast
                  </h2>
                  <p className="text-xs text-slate-400">
                    Models house appreciation, vehicle/belonging depreciation curves, mortgage amortization & monthly surplus accumulation.
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  {[5, 10, 20].map((yr) => (
                    <button
                      key={yr}
                      type="button"
                      onClick={() => setHorizonYears(yr)}
                      className={`px-2.5 py-1 rounded text-xs font-mono-num ${
                        horizonYears === yr ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      +{yr}Y
                    </button>
                  ))}
                </div>
              </div>

              <WealthHorizonChart
                history={wealthMode === 'combined' ? wealth.combinedFamilyWealth.history : []}
                projection={
                  wealthMode === 'combined'
                    ? wealth.combinedFamilyWealth.projection
                    : wealth.myWealth.projection
                }
                currency={cur}
                privacyMode={privacyMode}
              />
            </section>

            {/* Assets / Belongings & Liabilities Registries */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                  <span className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                    Belongings, Property & Investments
                  </span>
                  <button
                    type="button"
                    onClick={() => setModal({ kind: 'asset' })}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-900 text-white text-xs"
                  >
                    <Plus className="w-3 h-3" /> Add Item
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
                      Mortgages, Loans & Credit Cards
                    </span>
                    <button
                      type="button"
                      onClick={() => setModal({ kind: 'liability' })}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 text-xs text-slate-700"
                    >
                      <Plus className="w-3 h-3" /> Add Liability
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
                            {(lb.aprBp / 100).toFixed(2)}% APR · Monthly{' '}
                            {fmt(lb.displayMonthlyMinor, wealth.combinedFamilyWealth.totalAssetsMinor || 1)}
                          </div>
                        </div>
                        <div className="font-mono-num text-xs font-semibold text-rose-700">
                          -{fmt(lb.displayBalanceMinor, wealth.combinedFamilyWealth.totalAssetsMinor || 1, true)}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                {/* Historical & Current Salaries */}
                <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                    <span className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                      Salary & Income History
                    </span>
                    <button
                      type="button"
                      onClick={() => setModal({ kind: 'income' })}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 text-xs text-slate-700"
                    >
                      <Plus className="w-3 h-3" /> Add Income
                    </button>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {wealth.salaryHistory.map((inc) => (
                      <div key={inc.id} className="px-4 py-2.5 flex items-center justify-between text-xs">
                        <div>
                          <div className="font-medium text-slate-800">{inc.name}</div>
                          <div className="text-[11px] text-slate-400 font-mono-num">
                            {inc.effectiveFrom} → {inc.effectiveTo || 'Present'} (Payday {inc.paydayDay})
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

        {/* ======================== TAB 5: SETTINGS, FX, PRIVACY & MCP ======================== */}
        {tab === 'settings' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Multi-Currency & Partner Privacy Scope */}
            <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
              <h2 className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                Currency, Partner Privacy Scope & Household Split
              </h2>

              <form
                className="space-y-4"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
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
                      partnerVisibility: fd.get('partnerVisibility') as PartnerVisibility,
                      sharedSplitMode: fd.get('sharedSplitMode') as SplitMode,
                    }),
                  });
                  await apiFetch('/api/settings/preferences', {
                    method: 'PATCH',
                    body: JSON.stringify({ fxRates: fxPayload }),
                  });
                  await reloadAll();
                }}
              >
                <div className="grid grid-cols-2 gap-3">
                  <label className="block text-xs space-y-1">
                    <span className="text-slate-600 font-medium">My Default Display Currency</span>
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
                    <span className="text-slate-600 font-medium">Default Shared Split</span>
                    <select
                      name="sharedSplitMode"
                      defaultValue={sharedWs?.defaultSplitMode || 'equal_50_50'}
                      className="w-full border border-slate-200 rounded-md px-2.5 py-1.5"
                    >
                      <option value="equal_50_50">50 / 50 Equal Split</option>
                      <option value="income_proportional">Proportional to Salary</option>
                      <option value="custom_bp">Custom Percentage</option>
                    </select>
                  </label>
                </div>

                <label className="block text-xs space-y-1">
                  <span className="text-slate-600 font-medium">
                    My Personal Workspace Privacy Scope ({boot.user.displayName})
                  </span>
                  <select
                    name="partnerVisibility"
                    defaultValue={myPersonalWs?.partnerVisibility || 'totals_only'}
                    className="w-full border border-slate-200 rounded-md px-2.5 py-1.5"
                  >
                    <option value="private">Keep Strictly Private (hidden from partner & family totals)</option>
                    <option value="totals_only">
                      Include Aggregate Totals Only in Combined Family Wealth (hide individual items)
                    </option>
                    <option value="readonly">Share Read-Only with Partner</option>
                  </select>
                </label>

                <div className="pt-2 border-t border-slate-100">
                  <div className="text-xs font-medium text-slate-600 mb-2">
                    Fixed Multi-Currency Conversion Estimates (1 Unit → GBP)
                  </div>
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
                  Save Preferences & FX Rates
                </button>
              </form>
            </section>

            {/* Bank Accounts + MCP Connector + Backups */}
            <div className="space-y-5">
              {/* Bank Accounts */}
              <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold flex items-center gap-1.5">
                    <Landmark className="w-3.5 h-3.5" /> Bank & Runway Accounts
                  </h2>
                  <button
                    type="button"
                    onClick={() => setModal({ kind: 'account' })}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 text-xs"
                  >
                    <Plus className="w-3 h-3" /> Add Account
                  </button>
                </div>
                <div className="divide-y divide-slate-100">
                  {budget.accounts.map((acc) => (
                    <div key={acc.id} className="py-2 flex items-center justify-between text-xs">
                      <div>
                        <span className="font-medium text-slate-800">{acc.name}</span>{' '}
                        <span className="text-slate-400">({acc.institution})</span>
                      </div>
                      <div className="font-mono-num font-semibold">
                        {formatDisplayValue(acc.balanceMinor, { currency: acc.currency, privacyMode })}
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
                      <Sparkles className="w-3.5 h-3.5 text-teal-700" /> AI / Receipt MCP Connector (`/api/mcp`)
                    </h2>
                    <p className="text-[11px] text-slate-400">
                      Mint a scoped key or 1-click copy a complete Agent Bootstrap Prompt (endpoint + token + MCP config) for any AI agent.
                    </p>
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
                      <Copy className="w-3.5 h-3.5 text-teal-400" /> Mint & Copy Bootstrap Prompt
                    </button>
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
                        await reloadAll();
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-teal-700 text-teal-800 bg-teal-50/60 hover:bg-teal-100/70 text-xs font-medium transition"
                    >
                      <KeyRound className="w-3.5 h-3.5" /> Mint Key
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
                  <div className="p-3 rounded-lg bg-amber-50/80 border border-amber-200 text-xs space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-amber-900">
                        New Scoped Token & Agent Bootstrap Prompt (shown once):
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={async () => {
                            await navigator.clipboard.writeText(newlyMintedKey);
                            setCopiedNotice('Raw token copied to clipboard!');
                            setTimeout(() => setCopiedNotice(null), 3000);
                          }}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-amber-300 bg-white text-slate-700 text-[11px] hover:bg-amber-50"
                        >
                          <Copy className="w-3 h-3" /> Copy Token
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            const promptText = buildAgentBootstrapPrompt({
                              origin: window.location.origin,
                              displayName: boot.user.displayName,
                              personalWorkspaceId: boot.user.personalWorkspaceId,
                              defaultCurrency: boot.user.defaultCurrency,
                              token: newlyMintedKey,
                            });
                            await navigator.clipboard.writeText(promptText);
                            setCopiedNotice('Full Agent Bootstrap Prompt copied to clipboard!');
                            setTimeout(() => setCopiedNotice(null), 3000);
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-teal-700 text-white text-[11px] font-medium hover:bg-teal-800"
                        >
                          <Copy className="w-3 h-3" /> Copy Bootstrap Prompt
                        </button>
                      </div>
                    </div>

                    <div className="font-mono-num text-[11px] bg-white border border-amber-200 rounded px-2.5 py-1.5 break-all select-all text-slate-800">
                      {newlyMintedKey}
                    </div>

                    <details className="group">
                      <summary className="cursor-pointer text-[11px] font-medium text-teal-800 hover:underline">
                        Preview / manually select full Agent Bootstrap Prompt
                      </summary>
                      <textarea
                        readOnly
                        rows={11}
                        onFocus={(e) => e.currentTarget.select()}
                        value={buildAgentBootstrapPrompt({
                          origin: window.location.origin,
                          displayName: boot.user.displayName,
                          personalWorkspaceId: boot.user.personalWorkspaceId,
                          defaultCurrency: boot.user.defaultCurrency,
                          token: newlyMintedKey,
                        })}
                        className="mt-2 w-full font-mono-num text-[11px] bg-white border border-slate-200 rounded p-2.5 text-slate-700 leading-relaxed"
                      />
                    </details>
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
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              </section>

              {/* Persistent Storage Backup & Starter Data Controls */}
              <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
                <h2 className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                  Persistent Storage & Data Controls
                </h2>
                <div className="flex flex-wrap gap-2">
                  <a
                    href="/api/settings/backup"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Download className="w-3.5 h-3.5" /> Download SQLite Backup
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
                    <RefreshCw className="w-3.5 h-3.5" /> Reset Demo Data
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!confirm('Clear all financial entries and start from an empty ledger?')) return;
                      await apiFetch('/api/settings/sample-data', {
                        method: 'POST',
                        body: JSON.stringify({ action: 'clear' }),
                      });
                      await reloadAll();
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-rose-200 text-xs text-rose-700 hover:bg-rose-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Clear All Entries
                  </button>
                </div>
              </section>
            </div>
          </div>
        )}
      </main>

      {/* ======================== DETAILS, LINKS & DOCUMENT VAULT DRAWER ======================== */}
      {drawer && (
        <div className="fixed inset-0 z-40 bg-slate-900/30 flex justify-end" onClick={() => setDrawer(null)}>
          <div
            className="w-full max-w-md bg-white h-full border-l border-slate-200 p-6 overflow-y-auto space-y-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-[10px] font-mono-num uppercase tracking-wider text-teal-700">
                  {drawer.entityType} details
                </div>
                <h3 className="text-lg font-semibold text-slate-900">{drawer.title}</h3>
                <p className="text-xs text-slate-500 font-mono-num">{drawer.subtitle}</p>
              </div>
              <button type="button" onClick={() => setDrawer(null)} className="p-1 text-slate-400 hover:text-slate-700">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Actionable Portal Links */}
            {(drawer.manageUrl || drawer.portalUrl || drawer.referenceNumber) && (
              <div className="p-3.5 rounded-lg bg-[#FAF9F6] border border-slate-200 space-y-2">
                <div className="text-[11px] font-mono-num uppercase text-slate-500 font-semibold">
                  Actionable Links & Policy Reference
                </div>
                {drawer.manageUrl && (
                  <a
                    href={drawer.manageUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-between text-xs font-medium text-teal-800 hover:underline"
                  >
                    <span>Manage / Cancel / Renewal Portal</span>
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
                    <span>Provider Account Login</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
                {drawer.referenceNumber && (
                  <div className="text-xs font-mono-num text-slate-600">
                    Ref / Policy #: <span className="font-semibold">{drawer.referenceNumber}</span>
                  </div>
                )}
              </div>
            )}

            {/* Sub-items breakdown if receipt */}
            {drawer.items && drawer.items.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[11px] font-mono-num uppercase text-slate-500 font-semibold">
                  Itemized Sub-Categories
                </div>
                <div className="border border-slate-200 rounded-md divide-y divide-slate-100">
                  {drawer.items.map((it) => (
                    <div key={it.id} className="px-3 py-2 flex justify-between text-xs">
                      <div>
                        <span className="font-medium">{it.name}</span>
                        {it.subCategory && <span className="text-slate-400"> · {it.subCategory}</span>}
                      </div>
                      <span className="font-mono-num">
                        {privacyMode ? '•••' : `${CURRENCY_SYMBOLS[drawer.currency]}${(it.amountMinor / 100).toFixed(2)}`}
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

            {/* Attachments / Invoices / Receipts Vault */}
            <div className="space-y-3 pt-2 border-t border-slate-200">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono-num uppercase tracking-wider text-slate-500 font-semibold">
                  Attached Invoices, PDFs & Photos ({drawerAttachments.length})
                </span>
                <label className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-900 text-white text-xs cursor-pointer">
                  <Upload className="w-3 h-3" /> Attach File
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
                <div className="text-xs text-slate-400">
                  No documents attached yet. Attach PDFs, insurance policies, or shop receipts here.
                </div>
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

            {/* Delete Item */}
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
                      : `/api/liabilities/${drawer.entityId}`;
                  await apiFetch(endpoint, { method: 'DELETE' });
                  setDrawer(null);
                  await reloadAll();
                }}
                className="text-xs text-rose-600 hover:underline inline-flex items-center gap-1"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete record
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ======================== QUICK CREATION MODALS ======================== */}
      {modal && (
        <div className="fixed inset-0 z-50 bg-slate-900/35 flex items-center justify-center p-4" onClick={() => setModal(null)}>
          <div
            className="bg-white border border-slate-200 rounded-xl max-w-lg w-full p-6 space-y-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 capitalize">Add {modal.kind}</h3>
              <button type="button" onClick={() => setModal(null)}>
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>

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
                    <span>Budget Scope</span>
                    <select name="workspaceId" className="w-full border border-slate-200 rounded px-2 py-1.5">
                      {writableWorkspaces.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span>Pot</span>
                    <select name="potId" className="w-full border border-slate-200 rounded px-2 py-1.5">
                      <option value="">— Unassigned —</option>
                      {budget.pots.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
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
                    placeholder="e.g. Summer Vacation, Car Insurance, Netflix"
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
                    <select name="currency" defaultValue={cur} className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num">
                      {(['GBP', 'EUR', 'PLN', 'USD', 'CHF'] as CurrencyCode[]).map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span>Cadence</span>
                    <select name="cadence" defaultValue="monthly" className="w-full border border-slate-200 rounded px-2 py-1.5">
                      <option value="monthly">Monthly</option>
                      <option value="annual">Yearly (12m)</option>
                      <option value="quarterly">Quarterly (3m)</option>
                      <option value="biannual">Every 6m</option>
                      <option value="once">One-Time Planned</option>
                      <option value="custom_months">Custom N Months</option>
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
                      defaultValue={`${yearMonth}-15`}
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
                  <span>Manage / Cancel / Insurance Portal URL (optional)</span>
                  <input
                    type="url"
                    name="manageUrl"
                    placeholder="https://..."
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5"
                  />
                </label>

                <button type="submit" className="w-full py-2 rounded bg-slate-900 text-white font-medium">
                  Save Scheduled Obligation
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
                    <select name="workspaceId" className="w-full border border-slate-200 rounded px-2 py-1.5">
                      {writableWorkspaces.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span>Pot / Sub-Pot</span>
                    <select name="potId" className="w-full border border-slate-200 rounded px-2 py-1.5">
                      <option value="">— Unassigned —</option>
                      {budget.pots.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="block space-y-1">
                  <span>Merchant / Shop</span>
                  <input required name="merchant" placeholder="Aldi, Shell, Amazon..." className="w-full border border-slate-200 rounded px-2.5 py-1.5" />
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <label className="space-y-1">
                    <span>Amount</span>
                    <input required type="number" step="0.01" name="amountMajor" className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num" />
                  </label>
                  <label className="space-y-1">
                    <span>Currency</span>
                    <select name="currency" defaultValue={cur} className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num">
                      {(['GBP', 'EUR', 'PLN', 'USD', 'CHF'] as CurrencyCode[]).map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span>Date</span>
                    <input required type="date" name="spentDate" defaultValue={new Date().toISOString().slice(0, 10)} className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num" />
                  </label>
                </div>
                <label className="block space-y-1">
                  <span>Notes</span>
                  <input name="description" placeholder="Optional details" className="w-full border border-slate-200 rounded px-2.5 py-1.5" />
                </label>
                <button type="submit" className="w-full py-2 rounded bg-slate-900 text-white font-medium">
                  Save Expense
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
                    <select name="workspaceId" className="w-full border border-slate-200 rounded px-2 py-1.5">
                      {writableWorkspaces.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span>Parent Pot (optional nesting)</span>
                    <select name="parentId" className="w-full border border-slate-200 rounded px-2 py-1.5">
                      <option value="">— Top-Level Pot —</option>
                      {budget.pots.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <label className="col-span-2 space-y-1">
                    <span>Pot Name</span>
                    <input required name="name" placeholder="e.g. Food, Butter, Car Maintenance" className="w-full border border-slate-200 rounded px-2.5 py-1.5" />
                  </label>
                  <label className="space-y-1">
                    <span>Color</span>
                    <input type="color" name="color" defaultValue="#2E6F7E" className="w-full h-8 border border-slate-200 rounded" />
                  </label>
                </div>
                <label className="block space-y-1">
                  <span>Rough Monthly Envelope Estimate (leave 0 if purely itemized/bill-driven)</span>
                  <input type="number" step="1" name="monthlyEstimateMajor" defaultValue="0" className="w-full border border-slate-200 rounded px-2.5 py-1.5 font-mono-num" />
                </label>
                <button type="submit" className="w-full py-2 rounded bg-slate-900 text-white font-medium">
                  Create Pot
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
                      portalUrl: fd.get('portalUrl') || null,
                    }),
                  });
                  setModal(null);
                  await reloadAll();
                }}
              >
                <div className="grid grid-cols-2 gap-2.5">
                  <label className="space-y-1">
                    <span>Owner Scope</span>
                    <select name="workspaceId" className="w-full border border-slate-200 rounded px-2 py-1.5">
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
                  <input required name="name" placeholder="e.g. Electric Mountain Bike, House, Car" className="w-full border border-slate-200 rounded px-2.5 py-1.5" />
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <label className="space-y-1">
                    <span>Current Value</span>
                    <input required type="number" step="1" name="currentValueMajor" className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num" />
                  </label>
                  <label className="space-y-1">
                    <span>Currency</span>
                    <select name="currency" defaultValue={cur} className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num">
                      {(['GBP', 'EUR', 'PLN', 'USD', 'CHF'] as CurrencyCode[]).map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span>Annual % (+ or -)</span>
                    <input required type="number" step="0.1" name="annualRatePct" defaultValue="-15" className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num" />
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  <label className="space-y-1">
                    <span>Purchase Price</span>
                    <input type="number" step="1" name="purchasePriceMajor" defaultValue="0" className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num" />
                  </label>
                  <label className="space-y-1">
                    <span>Minimum Residual Floor</span>
                    <input type="number" step="1" name="residualFloorMajor" defaultValue="0" className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num" />
                  </label>
                </div>
                <button type="submit" className="w-full py-2 rounded bg-slate-900 text-white font-medium">
                  Save Asset / Belonging
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
                      currency: fd.get('currency'),
                    }),
                  });
                  setModal(null);
                  await reloadAll();
                }}
              >
                <div className="grid grid-cols-2 gap-2.5">
                  <label className="space-y-1">
                    <span>Scope</span>
                    <select name="workspaceId" className="w-full border border-slate-200 rounded px-2 py-1.5">
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
                    <input required type="number" step="0.01" name="balanceMajor" className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num" />
                  </label>
                  <label className="space-y-1">
                    <span>APR %</span>
                    <input required type="number" step="0.01" name="aprPct" defaultValue="4.2" className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num" />
                  </label>
                  <label className="space-y-1">
                    <span>Monthly Payment</span>
                    <input required type="number" step="0.01" name="monthlyMajor" className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num" />
                  </label>
                </div>
                <input type="hidden" name="currency" value={cur} />
                <button type="submit" className="w-full py-2 rounded bg-slate-900 text-white font-medium">
                  Save Liability
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
                      workspaceId: boot.user.personalWorkspaceId,
                      name: fd.get('name'),
                      amountMinor: Math.round(Number(fd.get('amountMajor') || 0) * 100),
                      currency: fd.get('currency'),
                      cadence: fd.get('cadence'),
                      paydayDay: Number(fd.get('paydayDay') || 25),
                      effectiveFrom: fd.get('effectiveFrom'),
                      effectiveTo: fd.get('effectiveTo') || null,
                    }),
                  });
                  setModal(null);
                  await reloadAll();
                }}
              >
                <label className="block space-y-1">
                  <span>Income / Salary Title</span>
                  <input required name="name" placeholder="Net Monthly Salary" className="w-full border border-slate-200 rounded px-2.5 py-1.5" />
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <label className="space-y-1">
                    <span>Net Amount</span>
                    <input required type="number" step="0.01" name="amountMajor" className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num" />
                  </label>
                  <label className="space-y-1">
                    <span>Currency</span>
                    <select name="currency" defaultValue={cur} className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num">
                      {(['GBP', 'EUR', 'PLN', 'USD', 'CHF'] as CurrencyCode[]).map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span>Cadence</span>
                    <select name="cadence" defaultValue="monthly" className="w-full border border-slate-200 rounded px-2 py-1.5">
                      <option value="monthly">Monthly</option>
                      <option value="annual">Annual</option>
                    </select>
                  </label>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <label className="space-y-1">
                    <span>Payday (1-28)</span>
                    <input type="number" min={1} max={28} name="paydayDay" defaultValue={25} className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num" />
                  </label>
                  <label className="space-y-1">
                    <span>From</span>
                    <input required type="date" name="effectiveFrom" defaultValue={`${yearMonth}-01`} className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num" />
                  </label>
                  <label className="space-y-1">
                    <span>To (blank = current)</span>
                    <input type="date" name="effectiveTo" className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num" />
                  </label>
                </div>
                <button type="submit" className="w-full py-2 rounded bg-slate-900 text-white font-medium">
                  Save Income Stream
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
                    }),
                  });
                  setModal(null);
                  await reloadAll();
                }}
              >
                <div className="grid grid-cols-2 gap-2.5">
                  <label className="space-y-1">
                    <span>Workspace</span>
                    <select name="workspaceId" className="w-full border border-slate-200 rounded px-2 py-1.5">
                      {writableWorkspaces.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span>Bank / Institution</span>
                    <input name="institution" placeholder="Monzo, Starling, Revolut..." className="w-full border border-slate-200 rounded px-2 py-1.5" />
                  </label>
                </div>
                <label className="block space-y-1">
                  <span>Account Name</span>
                  <input required name="name" placeholder="Current Account" className="w-full border border-slate-200 rounded px-2.5 py-1.5" />
                </label>
                <div className="grid grid-cols-2 gap-2.5">
                  <label className="space-y-1">
                    <span>Current Balance</span>
                    <input required type="number" step="0.01" name="balanceMajor" className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num" />
                  </label>
                  <label className="space-y-1">
                    <span>Currency</span>
                    <select name="currency" defaultValue={cur} className="w-full border border-slate-200 rounded px-2 py-1.5 font-mono-num">
                      {(['GBP', 'EUR', 'PLN', 'USD', 'CHF'] as CurrencyCode[]).map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="isPrimaryRunway" defaultChecked />
                  <span>Include in monthly sufficiency runway check</span>
                </label>
                <button type="submit" className="w-full py-2 rounded bg-slate-900 text-white font-medium">
                  Save Bank Account
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
