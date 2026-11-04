export type CurrencyCode = 'GBP' | 'EUR' | 'PLN' | 'USD' | 'CHF';

export type LocaleCode = 'en' | 'pl';

export type PartnerVisibility = 'private' | 'totals_only' | 'readonly';

export type WorkspaceKind = 'personal' | 'shared' | 'company';

export type WorkspaceRole = 'owner' | 'editor' | 'viewer' | 'totals_only';

export type AuthProviderKind = 'oidc' | 'local' | 'both';

export type CadenceKind =
  | 'once'
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'biannual'
  | 'annual'
  | 'custom_months';

export type SplitMode = 'equal_50_50' | 'income_proportional' | 'custom_bp' | 'owner_only';

export type AssetClass = 'property' | 'vehicle' | 'belonging' | 'cash_savings' | 'investment';

export type CurveModel = 'compound_annual' | 'linear_annual' | 'manual_only';

export type LiabilityKind = 'mortgage' | 'loan' | 'credit_card';

export interface FxRateRecord {
  currency: CurrencyCode;
  /** How many GBP equals 1 unit of `currency` (e.g., GBP=1.0, EUR=0.85, PLN=0.20, USD=0.79, CHF=0.90) */
  rateToGbp: number;
  symbol: string;
  updatedAt: string;
}

export interface UserProfile {
  id: string;
  handle: string;
  displayName: string;
  email: string;
  defaultCurrency: CurrencyCode;
  personalWorkspaceId: string;
  locale: LocaleCode;
  authProvider: AuthProviderKind;
  isAdmin: boolean;
  isActive: boolean;
}

export interface WorkspaceMemberRecord {
  workspaceId: string;
  userId: string;
  handle: string;
  displayName: string;
  role: WorkspaceRole;
}

export interface WorkspaceRecord {
  id: string;
  slug: string;
  name: string;
  kind: WorkspaceKind;
  ownerUserId: string | null;
  partnerVisibility: PartnerVisibility;
  defaultSplitMode: SplitMode;
  waderaCustomSplitBp: number; // 0..10000 basis points (5000 = 50.00%)
}

export interface BankAccountRecord {
  id: string;
  workspaceId: string;
  name: string;
  institution: string;
  currency: CurrencyCode;
  balanceMinor: number;
  isPrimaryRunway: boolean;
  portalUrl: string | null;
  notes: string | null;
  updatedAt: string;
}

export interface IncomeStreamRecord {
  id: string;
  workspaceId: string;
  accountId?: string | null;
  name: string;
  sourceKind: 'salary' | 'contract' | 'dividend' | 'side_income' | 'other';
  amountMinor: number;
  currency: CurrencyCode;
  cadence: 'monthly' | 'annual' | 'once';
  paydayDay: number; // 1..28
  effectiveFrom: string; // YYYY-MM-DD (supports historical salary tracking)
  effectiveTo: string | null; // null = currently active
  isActive: boolean;
  portalUrl: string | null;
  notes: string | null;
}

export interface PotRecord {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  icon: string;
  color: string;
  /** When true, monthlyEstimateMinor acts as a low-effort rough budget envelope unless itemized spend exceeds it */
  envelopeMode: boolean;
  monthlyEstimateMinor: number;
  currency: CurrencyCode;
  tags: string[];
  sortOrder: number;
}

export interface ObligationRecord {
  id: string;
  workspaceId: string;
  potId: string | null;
  accountId?: string | null;
  name: string;
  amountMinor: number;
  currency: CurrencyCode;
  cadence: CadenceKind;
  intervalMonths: number; // 1 for monthly, 3 for quarterly, 6 for biannual, 12 for annual, or custom N
  nextDueDate: string; // YYYY-MM-DD
  dueDay: number; // 1..31
  /** Accumulated sinking-fund reserve ('Preserve') already set aside toward nextDueDate in obligation's native currency */
  preservedMinor: number;
  /** Whether multi-month/future payments automatically budget a monthly 'Preserve' slice */
  autoPreserve: boolean;
  splitMode: SplitMode;
  waderaSplitBp: number; // 0..10000
  tags: string[];
  manageUrl: string | null;
  portalUrl: string | null;
  referenceNumber: string | null;
  renewalNoticeDays: number | null;
  notes: string | null;
  isActive: boolean;
}

export interface PaymentOccurrenceRecord {
  id: string;
  obligationId: string;
  accountId?: string | null;
  yearMonth: string; // YYYY-MM
  dueDate: string; // YYYY-MM-DD
  expectedMinor: number;
  actualPaidMinor: number | null;
  currency: CurrencyCode;
  status: 'upcoming' | 'paid' | 'skipped';
  paidAt: string | null;
  notes: string | null;
}

export interface ExpenseSubItem {
  id: string;
  name: string;
  subCategory: string | null;
  amountMinor: number;
}

export interface ExpenseEntryRecord {
  id: string;
  workspaceId: string;
  potId: string | null;
  accountId?: string | null;
  flowDirection?: 'outflow' | 'inflow';
  merchant: string;
  description: string;
  amountMinor: number;
  currency: CurrencyCode;
  spentDate: string; // YYYY-MM-DD
  tags: string[];
  portalUrl: string | null;
  source: 'manual' | 'mcp' | 'import';
  items: ExpenseSubItem[];
  createdAt: string;
}

export interface AssetBelongingRecord {
  id: string;
  workspaceId: string;
  name: string;
  assetClass: AssetClass;
  purchaseDate: string | null;
  purchasePriceMinor: number;
  currentValueMinor: number;
  currency: CurrencyCode;
  curveModel: CurveModel;
  /** Annual appreciation (+350 = +3.50%/yr) or depreciation (-1500 = -15.00%/yr) in basis points */
  annualRateBp: number;
  residualFloorMinor: number;
  portalUrl: string | null;
  manageUrl: string | null;
  referenceNumber: string | null;
  notes: string | null;
  updatedAt: string;
}

export interface LiabilityRecord {
  id: string;
  workspaceId: string;
  linkedAssetId: string | null;
  name: string;
  kind: LiabilityKind;
  balanceMinor: number;
  aprBp: number; // e.g., 425 = 4.25% APR
  monthlyPaymentMinor: number;
  currency: CurrencyCode;
  endDate: string | null;
  portalUrl: string | null;
  referenceNumber: string | null;
  notes: string | null;
  updatedAt: string;
}

export interface WealthSnapshotRecord {
  id: string;
  workspaceId: string;
  snapshotDate: string; // YYYY-MM-DD
  totalAssetsGbpMinor: number;
  totalLiabilitiesGbpMinor: number;
  netWorthGbpMinor: number;
  grossAnnualIncomeGbpMinor: number | null;
  note: string | null;
}

export interface AttachmentRecord {
  id: string;
  workspaceId: string;
  entityType: 'obligation' | 'expense' | 'asset' | 'liability' | 'income' | 'pot';
  entityId: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  label: string | null;
  createdAt: string;
}

export type { HorizonProjectionPoint, PotBreadcrumbInfo, PotRollupNode } from './financeEngine.js';
