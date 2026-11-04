import type {
  AssetBelongingRecord,
  AttachmentRecord,
  BankAccountRecord,
  CurrencyCode,
  ExpenseEntryRecord,
  FxRateRecord,
  HorizonProjectionPoint,
  IncomeStreamRecord,
  LiabilityRecord,
  ObligationRecord,
  PartnerVisibility,
  PaymentOccurrenceRecord,
  PotRecord,
  PotRollupNode,
  SplitMode,
  UserProfile,
  WorkspaceRecord,
} from '../shared/types.js';

export interface AuthStatusResponse {
  authenticated: boolean;
  via: string;
  authMode: 'authentik' | 'dev';
  oidcConfigured: boolean;
  loginUrl: string;
  user: {
    id: string;
    handle: 'wadera' | 'walter';
    displayName: string;
    defaultCurrency: CurrencyCode;
  } | null;
  devUsers?: Array<{ handle: string; displayName: string }>;
}

export interface WorkspaceWithAccess extends WorkspaceRecord {
  canReadItems: boolean;
  canWrite: boolean;
  includedInFamilyWealth: boolean;
}

export interface BootstrapResponse {
  user: UserProfile;
  users: Array<{ id: string; handle: string; displayName: string; personalWorkspaceId: string }>;
  workspaces: WorkspaceWithAccess[];
  fxRates: FxRateRecord[];
  apiKeys: Array<{ id: string; label: string; keyPrefix: string; createdAt: string; lastUsedAt: string | null }>;
}

export interface EnrichedObligation extends ObligationRecord {
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
}

export interface BudgetMonthResponse {
  yearMonth: string;
  scope: 'all' | 'shared' | 'personal' | 'partner';
  displayCurrency: CurrencyCode;
  accounts: BankAccountRecord[];
  incomes: Array<IncomeStreamRecord & { monthlyDisplayMinor: number }>;
  allIncomes: IncomeStreamRecord[];
  pots: PotRecord[];
  potTree: PotRollupNode[];
  obligations: EnrichedObligation[];
  expenses: ExpenseEntryRecord[];
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
    totalPreserveSliceMinor: number;
    unallocatedEnvelopeRemainingMinor: number;
    totalNeededTillMonthEndMinor: number;
    projectedEndBalanceMinor: number;
    shortfallMinor: number;
    isSufficient: boolean;
    dailyCurve: Array<{ day: number; balanceMinor: number; label?: string }>;
  };
  sankey: {
    nodes: Array<{ id: string; name: string; stage: number; color: string }>;
    links: Array<{ source: string; target: string; valueMinor: number }>;
  };
  trend6m: Array<{ yearMonth: string; incomeMinor: number; spendMinor: number; savedMinor: number }>;
}

export interface WealthOverviewResponse {
  displayCurrency: CurrencyCode;
  horizonYears: number;
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

export type { PartnerVisibility, SplitMode };
