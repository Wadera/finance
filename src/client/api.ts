import type {
  AssetBelongingRecord,
  AttachmentRecord,
  AuthProviderKind,
  BankAccountRecord,
  CurrencyCode,
  ExpenseEntryRecord,
  FxRateRecord,
  HorizonProjectionPoint,
  IncomeStreamRecord,
  LiabilityRecord,
  LocaleCode,
  ObligationRecord,
  PartnerVisibility,
  PaymentOccurrenceRecord,
  PotRecord,
  PotRollupNode,
  SplitMode,
  UserProfile,
  WorkspaceKind,
  WorkspaceMemberRecord,
  WorkspaceRecord,
  WorkspaceRole,
} from '../shared/types.js';

export interface AuthStatusResponse {
  authenticated: boolean;
  via: string;
  authMode: 'authentik' | 'dev';
  oidcConfigured: boolean;
  localLoginEnabled?: boolean;
  loginUrl: string;
  user: {
    id: string;
    handle: string;
    displayName: string;
    defaultCurrency: CurrencyCode;
    locale?: LocaleCode;
    isAdmin?: boolean;
  } | null;
  devUsers?: Array<{ handle: string; displayName: string }>;
}

export interface WorkspaceWithAccess extends WorkspaceRecord {
  role: WorkspaceRole | null;
  canReadItems: boolean;
  canWrite: boolean;
  canManage: boolean;
  includedInFamilyWealth: boolean;
  members: WorkspaceMemberRecord[];
}

export interface DirectoryUser {
  id: string;
  handle: string;
  displayName: string;
  email?: string;
  personalWorkspaceId: string;
  authProvider: AuthProviderKind;
  defaultCurrency: CurrencyCode;
  locale: LocaleCode;
  isAdmin: boolean;
  isActive: boolean;
}

export interface BootstrapResponse {
  user: UserProfile;
  users: DirectoryUser[];
  workspaces: WorkspaceWithAccess[];
  fxRates: FxRateRecord[];
  apiKeys: Array<{ id: string; label: string; keyPrefix: string; createdAt: string; lastUsedAt: string | null }>;
}

export interface EnrichedObligation extends ObligationRecord {
  accountName?: string | null;
  metrics: {
    obligationId: string;
    isDueThisMonth: boolean;
    monthsUntilDue: number;
    dueThisMonthNativeMinor: number;
    monthlyPreserveNativeMinor: number;
    effectiveMonthlyBurdenNativeMinor: number;
  };
  occurrence: PaymentOccurrenceRecord | null;
  isPaidThisMonth: boolean;
  userShareBp: number;
  dueDisplayMinor: number;
  preserveDisplayMinor: number;
  effectiveDisplayMinor: number;
  targetDisplayMinor: number;
  preservedDisplayMinor: number;
  liabilityName?: string | null;
}

export type EnrichedExpense = ExpenseEntryRecord & {
  displayAmountMinor: number;
  accountName?: string | null;
  liabilityName?: string | null;
};

export interface EnrichedIncome extends IncomeStreamRecord {
  accountName?: string | null;
  monthlyDisplayMinor: number;
  expectedDate: string;
  isReceivedThisMonth: boolean;
  receivedAt: string | null;
}

export interface NextMonthBreakdownItem {
  id: string;
  potId: string | null;
  name: string;
  color: string;
  displayMinor: number;
}

export interface CashflowBridgeData {
  prevYearMonth: string;
  nextYearMonth: string;
  primaryPaydayDay: number;
  overflowInMinor: number;
  thisMonthSpendingMinor: number;
  thisMonthBufferMinor: number;
  thisMonthShortfallMinor: number;
  upcomingSalaryTotalMinor: number;
  upcomingSalaryReceivedMinor: number;
  upcomingSalaryPendingMinor: number;
  nextMonthPreSalaryMinor: number;
  projectedFreeFromUpcomingMinor: number;
  nextMonthBreakdown: NextMonthBreakdownItem[];
}

export interface TimelineLedgerEntry {
  id: string;
  kind: 'expense' | 'paid_bill' | 'sinking_set_aside';
  flowDirection?: 'outflow' | 'inflow';
  entityType: 'expense' | 'obligation';
  entityId: string;
  occurrenceId?: string;
  workspaceId: string;
  accountId?: string | null;
  accountName?: string | null;
  potId: string | null;
  potName: string | null;
  potColor: string;
  title: string;
  subtitle: string;
  date: string;
  timestamp: string;
  day: number;
  amountMinor: number;
  currency: CurrencyCode;
  displayAmountMinor: number;
}

export interface DailyCurvePoint {
  day: number;
  date?: string;
  balanceMinor: number;
  label?: string;
  events?: Array<{
    id: string;
    kind: 'expense' | 'paid_bill' | 'sinking_set_aside' | 'unpaid_bill' | 'income';
    title: string;
    timestamp?: string;
    displayMinor: number;
  }>;
}

export interface HorizonBucket {
  key: string;
  label: string;
  subLabel: string;
  incomeMinor: number;
  spendMinor: number;
  savedMinor: number;
  cumulativeSavedMinor: number;
  savingsRatePct: number;
}

export interface HorizonSummary {
  horizonMonths: 1 | 3 | 6 | 12 | 60 | 120;
  chartMonthsCount: number;
  startYearMonth: string;
  endYearMonth: string;
  totalIncomeMinor: number;
  totalSpendMinor: number;
  totalSavedMinor: number;
  avgMonthlyIncomeMinor: number;
  avgMonthlySpendMinor: number;
  savingsRatePct: number;
  buckets: HorizonBucket[];
}

export interface BudgetMonthResponse {
  yearMonth: string;
  scope: string;
  displayCurrency: CurrencyCode;
  accounts: BankAccountRecord[];
  allAccounts?: BankAccountRecord[];
  allLiabilities?: LiabilityRecord[];
  incomes: EnrichedIncome[];
  allIncomes: IncomeStreamRecord[];
  pots: PotRecord[];
  potTree: PotRollupNode[];
  obligations: EnrichedObligation[];
  expenses: EnrichedExpense[];
  timelineLedger: TimelineLedgerEntry[];
  kpis: {
    totalIncomeMinor: number;
    potPlannedTotalMinor: number;
    totalPreserveSliceMinor: number;
    netMonthlySurplusMinor: number;
    savingsRatePct: number;
  };
  runway: {
    runwayCashMinor: number;
    remainingPaydaysIncomeMinor: number;
    unpaidBillsMinor: number;
    unpaidPrePaydayBillsMinor: number;
    totalPreserveSliceMinor: number;
    unallocatedEnvelopeRemainingMinor: number;
    totalNeededBeforePaydayMinor: number;
    prePaydayBufferMinor: number;
    currentCashAfterMonthBillsMinor: number;
    totalNeededTillMonthEndMinor: number;
    projectedEndBalanceMinor: number;
    projectedAfterNextMonthReserveMinor: number;
    shortfallMinor: number;
    isSufficient: boolean;
    dailyCurve: DailyCurvePoint[];
  };
  cashflowBridge: CashflowBridgeData;
  sankey: {
    nodes: Array<{ id: string; name: string; stage: number; color: string }>;
    links: Array<{ source: string; target: string; valueMinor: number }>;
  };
  trend6m: Array<{ yearMonth: string; incomeMinor: number; spendMinor: number; savedMinor: number }>;
  horizonSummary?: HorizonSummary;
}

export interface WealthOverviewResponse {
  displayCurrency: CurrencyCode;
  horizonYears: number;
  scope?: string;
  myWealth: {
    totalAssetsMinor: number;
    totalLiabilitiesMinor: number;
    netWorthMinor: number;
    projection: HorizonProjectionPoint[];
  };
  partnerWealth: {
    visibility: PartnerVisibility;
    includedInCombined: boolean;
    totalAssetsMinor: number | null;
    totalLiabilitiesMinor: number | null;
    netWorthMinor: number | null;
  };
  combinedFamilyWealth: {
    totalAssetsMinor: number;
    totalLiabilitiesMinor: number;
    netWorthMinor: number;
    estMonthlySavingsMinor: number;
    history: Array<{ date: string; netWorthMinor: number; assetsMinor: number; liabilitiesMinor: number }>;
    projection: HorizonProjectionPoint[];
  };
  assets: Array<AssetBelongingRecord & { displayValueMinor: number; displayPurchaseMinor: number }>;
  liabilities: Array<LiabilityRecord & { displayBalanceMinor: number; displayMonthlyMinor: number }>;
  salaryHistory: IncomeStreamRecord[];
}

export type QuickAddTarget =
  | {
      targetKind: 'pot';
      potId: string;
      potName: string;
      workspaceId: string;
      currency: CurrencyCode;
      color: string;
    }
  | {
      targetKind: 'obligation';
      itemId: string;
      itemName: string;
      workspaceId: string;
      parentPotId: string | null;
      amountMinor: number;
      currency: CurrencyCode;
    }
  | {
      targetKind: 'expense';
      itemId: string;
      itemName: string;
      workspaceId: string;
      parentPotId: string | null;
      amountMinor: number;
      currency: CurrencyCode;
    };

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers || {});
  if (init?.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(url, { ...init, headers, credentials: 'same-origin' });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(errBody.error || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listAttachmentsApi(entityType: string, entityId: string): Promise<AttachmentRecord[]> {
  const data = await apiFetch<{ attachments: AttachmentRecord[] }>(
    `/api/attachments?entityType=${encodeURIComponent(entityType)}&entityId=${encodeURIComponent(entityId)}`
  );
  return data.attachments;
}

export type { PartnerVisibility, SplitMode, WorkspaceKind, WorkspaceRole };
