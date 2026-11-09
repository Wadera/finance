import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { convertMinor, DEFAULT_FX_RATES, rateMapFromList } from '../shared/currency.js';
import { applyObligationPaymentReset, computeObligationMonthMetrics } from '../shared/financeEngine.js';
import type {
  AccountTransferRecord,
  AssetBelongingRecord,
  AttachmentRecord,
  AuthProviderKind,
  BankAccountRecord,
  CadenceKind,
  CurrencyCode,
  ExpenseEntryRecord,
  ExpenseSubItem,
  FxRateRecord,
  IncomeStreamRecord,
  LiabilityRecord,
  LocaleCode,
  ObligationRecord,
  PartnerVisibility,
  PaymentOccurrenceRecord,
  PotRecord,
  SplitMode,
  TransactionKind,
  TransactionStatus,
  UserProfile,
  WealthSnapshotRecord,
  WorkspaceKind,
  WorkspaceMemberRecord,
  WorkspaceRecord,
  WorkspaceRole,
} from '../shared/types.js';

export function hashPassword(rawPassword: string): string {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(rawPassword, salt, 64).toString('base64url');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(rawPassword: string, stored: string | null | undefined): boolean {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const [, salt, expectedB64] = parts;
  const actual = crypto.scryptSync(rawPassword, salt, 64);
  const expected = Buffer.from(expectedB64, 'base64url');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export interface DataPaths {
  dataDir: string;
  dbDir: string;
  dbFile: string;
  attachmentsDir: string;
  backupsDir: string;
}

export function resolveDataPaths(rawDataDir?: string): DataPaths {
  const dataDir = path.resolve(rawDataDir || process.env.DATA_DIR || './data');
  const dbDir = path.join(dataDir, 'db');
  const attachmentsDir = path.join(dataDir, 'attachments');
  const backupsDir = path.join(dataDir, 'backups');
  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(attachmentsDir, { recursive: true });
  fs.mkdirSync(backupsDir, { recursive: true });
  return {
    dataDir,
    dbDir,
    dbFile: path.join(dbDir, 'skyday-finance.sqlite'),
    attachmentsDir,
    backupsDir,
  };
}

export class FinanceStore {
  public readonly db: DatabaseSync;
  public readonly paths: DataPaths;

  constructor(rawDataDir?: string) {
    this.paths = resolveDataPaths(rawDataDir);
    this.db = new DatabaseSync(this.paths.dbFile);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.seedCoreDefaults();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fx_rates (
        currency TEXT PRIMARY KEY,
        rate_to_gbp REAL NOT NULL,
        symbol TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        handle TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        default_currency TEXT NOT NULL DEFAULT 'GBP',
        personal_workspace_id TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        owner_user_id TEXT,
        partner_visibility TEXT NOT NULL DEFAULT 'totals_only',
        default_split_mode TEXT NOT NULL DEFAULT 'equal_50_50',
        wadera_custom_split_bp INTEGER NOT NULL DEFAULT 5000
      );

      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        institution TEXT NOT NULL DEFAULT '',
        currency TEXT NOT NULL DEFAULT 'GBP',
        balance_minor INTEGER NOT NULL DEFAULT 0,
        is_primary_runway INTEGER NOT NULL DEFAULT 1,
        portal_url TEXT,
        notes TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS income_streams (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        source_kind TEXT NOT NULL DEFAULT 'salary',
        amount_minor INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'GBP',
        cadence TEXT NOT NULL DEFAULT 'monthly',
        payday_day INTEGER NOT NULL DEFAULT 25,
        effective_from TEXT NOT NULL,
        effective_to TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        portal_url TEXT,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS pots (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES pots(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        icon TEXT NOT NULL DEFAULT 'folder',
        color TEXT NOT NULL DEFAULT '#2E6F7E',
        envelope_mode INTEGER NOT NULL DEFAULT 0,
        monthly_estimate_minor INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'GBP',
        tags_json TEXT NOT NULL DEFAULT '[]',
        sort_order INTEGER NOT NULL DEFAULT 10
      );

      CREATE TABLE IF NOT EXISTS obligations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        pot_id TEXT REFERENCES pots(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        amount_minor INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'GBP',
        cadence TEXT NOT NULL DEFAULT 'monthly',
        interval_months INTEGER NOT NULL DEFAULT 1,
        next_due_date TEXT NOT NULL,
        due_day INTEGER NOT NULL DEFAULT 1,
        preserved_minor INTEGER NOT NULL DEFAULT 0,
        auto_preserve INTEGER NOT NULL DEFAULT 1,
        split_mode TEXT NOT NULL DEFAULT 'equal_50_50',
        wadera_split_bp INTEGER NOT NULL DEFAULT 5000,
        tags_json TEXT NOT NULL DEFAULT '[]',
        manage_url TEXT,
        portal_url TEXT,
        reference_number TEXT,
        renewal_notice_days INTEGER,
        notes TEXT,
        is_active INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS payment_occurrences (
        id TEXT PRIMARY KEY,
        obligation_id TEXT NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
        year_month TEXT NOT NULL,
        due_date TEXT NOT NULL,
        expected_minor INTEGER NOT NULL,
        actual_paid_minor INTEGER,
        currency TEXT NOT NULL DEFAULT 'GBP',
        status TEXT NOT NULL DEFAULT 'upcoming',
        paid_at TEXT,
        notes TEXT,
        UNIQUE(obligation_id, year_month)
      );

      CREATE TABLE IF NOT EXISTS income_occurrences (
        id TEXT PRIMARY KEY,
        income_id TEXT NOT NULL REFERENCES income_streams(id) ON DELETE CASCADE,
        year_month TEXT NOT NULL,
        expected_date TEXT NOT NULL,
        received_minor INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'GBP',
        status TEXT NOT NULL DEFAULT 'received',
        received_at TEXT NOT NULL,
        UNIQUE(income_id, year_month)
      );

      CREATE TABLE IF NOT EXISTS expenses (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        pot_id TEXT REFERENCES pots(id) ON DELETE SET NULL,
        merchant TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        amount_minor INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'GBP',
        spent_date TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        portal_url TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        items_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        asset_class TEXT NOT NULL DEFAULT 'belonging',
        purchase_date TEXT,
        purchase_price_minor INTEGER NOT NULL DEFAULT 0,
        current_value_minor INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'GBP',
        curve_model TEXT NOT NULL DEFAULT 'compound_annual',
        annual_rate_bp INTEGER NOT NULL DEFAULT 0,
        residual_floor_minor INTEGER NOT NULL DEFAULT 0,
        portal_url TEXT,
        manage_url TEXT,
        reference_number TEXT,
        notes TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS liabilities (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        linked_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'loan',
        balance_minor INTEGER NOT NULL DEFAULT 0,
        apr_bp INTEGER NOT NULL DEFAULT 0,
        monthly_payment_minor INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'GBP',
        end_date TEXT,
        portal_url TEXT,
        reference_number TEXT,
        notes TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS wealth_snapshots (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        snapshot_date TEXT NOT NULL,
        total_assets_gbp_minor INTEGER NOT NULL,
        total_liabilities_gbp_minor INTEGER NOT NULL,
        net_worth_gbp_minor INTEGER NOT NULL,
        gross_annual_income_gbp_minor INTEGER,
        note TEXT
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        label TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_sha256 TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS workspace_members (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'editor',
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS account_transfers (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        from_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        to_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        from_amount_minor INTEGER NOT NULL,
        from_currency TEXT NOT NULL DEFAULT 'GBP',
        to_amount_minor INTEGER NOT NULL,
        to_currency TEXT NOT NULL DEFAULT 'GBP',
        fx_rate REAL,
        fee_minor INTEGER NOT NULL DEFAULT 0,
        transfer_date TEXT NOT NULL,
        bank_timestamp TEXT,
        status TEXT NOT NULL DEFAULT 'posted',
        description TEXT NOT NULL DEFAULT '',
        reference TEXT,
        evidence TEXT,
        idempotency_key TEXT,
        outflow_tx_id TEXT NOT NULL,
        inflow_tx_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reconciliation_batches (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'applied',
        summary_json TEXT NOT NULL,
        undo_log_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reversed_at TEXT
      );
    `);

    // Idempotent column migrations for existing production SQLite databases
    const userCols = new Set(
      (this.db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>).map((c) => c.name)
    );
    if (!userCols.has('auth_provider')) {
      this.db.exec(`ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'oidc'`);
    }
    if (!userCols.has('password_hash')) {
      this.db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
    }
    if (!userCols.has('locale')) {
      this.db.exec(`ALTER TABLE users ADD COLUMN locale TEXT NOT NULL DEFAULT 'en'`);
    }
    if (!userCols.has('is_admin')) {
      this.db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`);
    }
    if (!userCols.has('is_active')) {
      this.db.exec(`ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`);
    }
    if (!userCols.has('created_at')) {
      this.db.exec(`ALTER TABLE users ADD COLUMN created_at TEXT NOT NULL DEFAULT '2026-11-04T00:00:00Z'`);
    }

    const addColumnIfMissing = (table: string, colName: string, definitionSql: string) => {
      const cols = new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
      );
      if (!cols.has(colName)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${colName} ${definitionSql}`);
      }
    };

    addColumnIfMissing('expenses', 'account_id', 'TEXT REFERENCES accounts(id) ON DELETE SET NULL');
    addColumnIfMissing('expenses', 'liability_id', 'TEXT REFERENCES liabilities(id) ON DELETE SET NULL');
    addColumnIfMissing('expenses', 'flow_direction', "TEXT NOT NULL DEFAULT 'outflow'");
    addColumnIfMissing('expenses', 'kind', "TEXT NOT NULL DEFAULT 'expense'");
    addColumnIfMissing('expenses', 'status', "TEXT NOT NULL DEFAULT 'posted'");
    addColumnIfMissing('expenses', 'bank_timestamp', 'TEXT');
    addColumnIfMissing('expenses', 'observed_at', 'TEXT');
    addColumnIfMissing('expenses', 'original_amount_minor', 'INTEGER');
    addColumnIfMissing('expenses', 'original_currency', 'TEXT');
    addColumnIfMissing('expenses', 'fx_rate', 'REAL');
    addColumnIfMissing('expenses', 'fee_minor', 'INTEGER');
    addColumnIfMissing('expenses', 'reference', 'TEXT');
    addColumnIfMissing('expenses', 'evidence', 'TEXT');
    addColumnIfMissing('expenses', 'provider_tx_id', 'TEXT');
    addColumnIfMissing('expenses', 'idempotency_key', 'TEXT');
    addColumnIfMissing('expenses', 'transfer_id', 'TEXT');
    addColumnIfMissing('expenses', 'transfer_peer_id', 'TEXT');
    addColumnIfMissing('expenses', 'transfer_peer_account_id', 'TEXT');
    addColumnIfMissing('expenses', 'available_applied', 'INTEGER NOT NULL DEFAULT 1');
    addColumnIfMissing('expenses', 'booked_applied', 'INTEGER NOT NULL DEFAULT 1');
    addColumnIfMissing('expenses', 'updated_at', 'TEXT');

    addColumnIfMissing('accounts', 'pocket_money_target_minor', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing('accounts', 'booked_balance_minor', 'INTEGER');
    addColumnIfMissing('accounts', 'pending_debit_minor', 'INTEGER');
    addColumnIfMissing('accounts', 'pending_credit_minor', 'INTEGER');
    addColumnIfMissing('accounts', 'observed_at', 'TEXT');
    addColumnIfMissing('accounts', 'snapshot_source', 'TEXT');
    addColumnIfMissing('accounts', 'snapshot_evidence', 'TEXT');
    addColumnIfMissing('accounts', 'last_reconciled_at', 'TEXT');
    addColumnIfMissing('accounts', 'version', 'INTEGER NOT NULL DEFAULT 1');

    addColumnIfMissing('obligations', 'account_id', 'TEXT REFERENCES accounts(id) ON DELETE SET NULL');
    addColumnIfMissing('obligations', 'preserve_account_id', 'TEXT REFERENCES accounts(id) ON DELETE SET NULL');
    addColumnIfMissing('obligations', 'liability_id', 'TEXT REFERENCES liabilities(id) ON DELETE SET NULL');
    addColumnIfMissing('obligations', 'final_amount_minor', 'INTEGER');
    addColumnIfMissing('obligations', 'end_date', 'TEXT');
    addColumnIfMissing('obligations', 'remaining_payments', 'INTEGER');

    addColumnIfMissing('payment_occurrences', 'account_id', 'TEXT REFERENCES accounts(id) ON DELETE SET NULL');
    addColumnIfMissing('payment_occurrences', 'liability_id', 'TEXT REFERENCES liabilities(id) ON DELETE SET NULL');
    addColumnIfMissing('payment_occurrences', 'liability_delta_minor', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing('payment_occurrences', 'bank_date', 'TEXT');
    addColumnIfMissing('payment_occurrences', 'recorded_at', 'TEXT');
    addColumnIfMissing('payment_occurrences', 'linked_transaction_id', 'TEXT');
    addColumnIfMissing('payment_occurrences', 'evidence', 'TEXT');
    addColumnIfMissing('payment_occurrences', 'idempotency_key', 'TEXT');
    addColumnIfMissing('payment_occurrences', 'balance_applied', 'INTEGER NOT NULL DEFAULT 0');

    addColumnIfMissing('income_streams', 'account_id', 'TEXT REFERENCES accounts(id) ON DELETE SET NULL');
    addColumnIfMissing('income_occurrences', 'account_id', 'TEXT REFERENCES accounts(id) ON DELETE SET NULL');
  }

  private seedCoreDefaults(): void {
    const insertFx = this.db.prepare(`
      INSERT OR IGNORE INTO fx_rates (currency, rate_to_gbp, symbol, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const r of DEFAULT_FX_RATES) {
      insertFx.run(r.currency, r.rateToGbp, r.symbol, r.updatedAt);
    }

    const insertUser = this.db.prepare(`
      INSERT OR IGNORE INTO users (id, handle, display_name, email, default_currency, personal_workspace_id, auth_provider, is_admin, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 'oidc', 1, 1)
    `);
    insertUser.run('usr-wadera', 'wadera', 'Wadera', 'wadera@skyday.eu', 'GBP', 'ws-wadera');
    insertUser.run('usr-walter', 'walter', 'Walter', 'walter@skyday.eu', 'GBP', 'ws-walter');
    // Ensure primary owners retain admin flag on migrated DBs
    this.db.prepare(`UPDATE users SET is_admin = 1 WHERE id IN ('usr-wadera', 'usr-walter')`).run();

    const insertWs = this.db.prepare(`
      INSERT OR IGNORE INTO workspaces (id, slug, name, kind, owner_user_id, partner_visibility, default_split_mode, wadera_custom_split_bp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertWs.run('ws-wadera', 'ws-wadera', 'Wadera Personal', 'personal', 'usr-wadera', 'totals_only', 'owner_only', 10000);
    insertWs.run('ws-walter', 'ws-walter', 'Walter Personal', 'personal', 'usr-walter', 'totals_only', 'owner_only', 0);
    insertWs.run('ws-home', 'ws-home', 'Shared Household', 'shared', 'usr-wadera', 'readonly', 'equal_50_50', 5000);
    this.db.prepare(`UPDATE workspaces SET owner_user_id = 'usr-wadera' WHERE id = 'ws-home' AND owner_user_id IS NULL`).run();

    // Ensure core workspace_members exist so multi-workspace sharing & isolation work seamlessly
    const insMem = this.db.prepare(`
      INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const nowIso = new Date().toISOString();
    insMem.run('ws-wadera', 'usr-wadera', 'owner', nowIso);
    insMem.run('ws-walter', 'usr-walter', 'owner', nowIso);
    insMem.run('ws-home', 'usr-wadera', 'owner', nowIso);
    insMem.run('ws-home', 'usr-walter', 'editor', nowIso);

    // Seed starter household architecture once on brand-new DB so charts & workflows work immediately out-of-the-box
    // (User can click "Reset / Clear Starter Data" in Settings at any time)
    const seeded = this.db.prepare(`SELECT value FROM app_meta WHERE key = 'initial_seed_v1'`).get() as
      | { value: string }
      | undefined;
    if (!seeded) {
      this.loadStarterHouseholdSample();
      this.db.prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES ('initial_seed_v1', 'done')`).run();
    }

    const payday27Migrated = this.db.prepare(`SELECT value FROM app_meta WHERE key = 'payday_27_v1'`).get() as
      | { value: string }
      | undefined;
    if (!payday27Migrated) {
      this.db
        .prepare(`UPDATE income_streams SET payday_day = 27 WHERE id = 'inc-wadera-cur' AND payday_day = 25`)
        .run();
      this.db.prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES ('payday_27_v1', 'done')`).run();
    }

    const accountLinksSeeded = this.db.prepare(`SELECT value FROM app_meta WHERE key = 'account_links_seeded_v1'`).get() as
      | { value: string }
      | undefined;
    if (!accountLinksSeeded) {
      this.backfillDefaultAccountLinks();
      this.db.prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES ('account_links_seeded_v1', 'done')`).run();
    }

    const careerHistory10y = this.db.prepare(`SELECT value FROM app_meta WHERE key = 'career_history_10y_v1'`).get() as
      | { value: string }
      | undefined;
    if (!careerHistory10y) {
      const insHistInc = this.db.prepare(`
        INSERT OR IGNORE INTO income_streams (id, workspace_id, account_id, name, source_kind, amount_minor, currency, cadence, payday_day, effective_from, effective_to, is_active, portal_url, notes)
        VALUES (?, ?, ?, ?, 'salary', ?, 'GBP', 'monthly', 27, ?, ?, 1, NULL, ?)
      `);
      insHistInc.run('inc-wadera-2017', 'ws-wadera', 'acc-wadera-main', 'Senior Engineering Role (2017–2020)', 385000, '2016-01-01', '2020-12-31', 'Historical career band');
      insHistInc.run('inc-wadera-2021', 'ws-wadera', 'acc-wadera-main', 'Staff Engineering Role (2021–2023)', 455000, '2021-01-01', '2023-12-31', 'Historical career band');
      this.db.prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES ('career_history_10y_v1', 'done')`).run();
    }

    const liabilityLinksSeeded = this.db.prepare(`SELECT value FROM app_meta WHERE key = 'liability_links_seeded_v1'`).get() as
      | { value: string }
      | undefined;
    if (!liabilityLinksSeeded) {
      this.backfillDefaultAccountLinks();
      this.db.prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES ('liability_links_seeded_v1', 'done')`).run();
    }

    // Backfill kind='transfer' for internal transfer entries and kind='deposit' for existing inflow rows
    this.db.exec(`
      UPDATE expenses
      SET kind = 'transfer'
      WHERE LOWER(TRIM(merchant)) LIKE 'transfer to %'
         OR LOWER(TRIM(merchant)) LIKE 'transfer from %';

      UPDATE expenses
      SET kind = 'deposit'
      WHERE flow_direction = 'inflow' AND (kind IS NULL OR kind = 'expense');
    `);
  }

  public backfillDefaultAccountLinks(): void {
    this.db.exec(`
      UPDATE income_streams
      SET account_id = (
        SELECT a.id FROM accounts a
        WHERE a.workspace_id = income_streams.workspace_id
        ORDER BY a.is_primary_runway DESC, a.id ASC LIMIT 1
      )
      WHERE account_id IS NULL;

      UPDATE obligations
      SET account_id = (
        SELECT a.id FROM accounts a
        WHERE a.workspace_id = obligations.workspace_id
        ORDER BY a.is_primary_runway DESC, a.id ASC LIMIT 1
      )
      WHERE account_id IS NULL;

      UPDATE obligations
      SET liability_id = 'liab-mortgage'
      WHERE (id = 'ob-mortgage' OR LOWER(name) LIKE '%mortgage%')
        AND liability_id IS NULL
        AND EXISTS (SELECT 1 FROM liabilities WHERE id = 'liab-mortgage');

      UPDATE expenses
      SET account_id = (
        SELECT a.id FROM accounts a
        WHERE a.workspace_id = expenses.workspace_id
        ORDER BY a.is_primary_runway DESC, a.id ASC LIMIT 1
      )
      WHERE account_id IS NULL;

      UPDATE payment_occurrences
      SET account_id = (
        SELECT o.account_id FROM obligations o
        WHERE o.id = payment_occurrences.obligation_id
      )
      WHERE account_id IS NULL;

      UPDATE payment_occurrences
      SET liability_id = (
        SELECT o.liability_id FROM obligations o
        WHERE o.id = payment_occurrences.obligation_id
      )
      WHERE liability_id IS NULL;

      UPDATE income_occurrences
      SET account_id = (
        SELECT i.account_id FROM income_streams i
        WHERE i.id = income_occurrences.income_id
      )
      WHERE account_id IS NULL;
    `);
  }

  public getFxRates(): FxRateRecord[] {
    const rows = this.db.prepare(`SELECT currency, rate_to_gbp, symbol, updated_at FROM fx_rates ORDER BY currency`).all() as Array<{
      currency: CurrencyCode;
      rate_to_gbp: number;
      symbol: string;
      updated_at: string;
    }>;
    return rows.map((r) => ({
      currency: r.currency,
      rateToGbp: r.rate_to_gbp,
      symbol: r.symbol,
      updatedAt: r.updated_at,
    }));
  }

  public updateFxRate(currency: CurrencyCode, rateToGbp: number): void {
    if (currency === 'GBP') return;
    this.db
      .prepare(`UPDATE fx_rates SET rate_to_gbp = ?, updated_at = ? WHERE currency = ?`)
      .run(rateToGbp, new Date().toISOString(), currency);
  }

  public getUsers(): UserProfile[] {
    const rows = this.db
      .prepare(
        `SELECT id, handle, display_name, email, default_currency, personal_workspace_id, locale, auth_provider, is_admin, is_active
         FROM users
         ORDER BY is_admin DESC, handle ASC`
      )
      .all() as Array<{
      id: string;
      handle: string;
      display_name: string;
      email: string;
      default_currency: CurrencyCode;
      personal_workspace_id: string;
      locale: LocaleCode;
      auth_provider: AuthProviderKind;
      is_admin: number;
      is_active: number;
    }>;
    return rows.map((u) => ({
      id: u.id,
      handle: u.handle,
      displayName: u.display_name,
      email: u.email,
      defaultCurrency: u.default_currency,
      personalWorkspaceId: u.personal_workspace_id,
      locale: u.locale === 'pl' ? 'pl' : 'en',
      authProvider: (u.auth_provider || 'oidc') as AuthProviderKind,
      isAdmin: Boolean(u.is_admin),
      isActive: u.is_active !== 0,
    }));
  }

  public getUserById(userId: string): UserProfile | null {
    return this.getUsers().find((u) => u.id === userId && u.isActive) ?? null;
  }

  public updateUserDefaultCurrency(userId: string, currency: CurrencyCode): void {
    this.db.prepare(`UPDATE users SET default_currency = ? WHERE id = ?`).run(currency, userId);
  }

  public updateUserLocale(userId: string, locale: LocaleCode): void {
    const safeLocale: LocaleCode = locale === 'pl' ? 'pl' : 'en';
    this.db.prepare(`UPDATE users SET locale = ? WHERE id = ?`).run(safeLocale, userId);
  }

  public authenticateLocalUser(identifier: string, password: string): UserProfile | null {
    const ident = identifier.trim().toLowerCase();
    if (!ident || !password) return null;
    const row = this.db
      .prepare(
        `SELECT id, password_hash, is_active
         FROM users
         WHERE LOWER(handle) = ? OR LOWER(email) = ?`
      )
      .get(ident, ident) as { id: string; password_hash: string | null; is_active: number } | undefined;
    if (!row || row.is_active === 0 || !row.password_hash) return null;
    if (!verifyPassword(password, row.password_hash)) return null;
    return this.getUserById(row.id);
  }

  public setUserPassword(userId: string, newPassword: string): void {
    if (newPassword.length < 6) {
      throw new Error('Password must be at least 6 characters');
    }
    const cur = this.db.prepare(`SELECT auth_provider FROM users WHERE id = ?`).get(userId) as
      | { auth_provider: string }
      | undefined;
    if (!cur) throw new Error('User not found');
    const nextProvider: AuthProviderKind = cur.auth_provider === 'oidc' ? 'both' : (cur.auth_provider as AuthProviderKind);
    this.db
      .prepare(`UPDATE users SET password_hash = ?, auth_provider = ? WHERE id = ?`)
      .run(hashPassword(newPassword), nextProvider, userId);
  }

  public createLocalUser(params: {
    handle: string;
    displayName: string;
    email?: string;
    password: string;
    defaultCurrency?: CurrencyCode;
    locale?: LocaleCode;
    isAdmin?: boolean;
    sharedWorkspaceGrants?: Array<{ workspaceId: string; role: WorkspaceRole }>;
  }): UserProfile {
    const cleanHandle = params.handle
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '');
    if (cleanHandle.length < 2) {
      throw new Error('Username handle must be at least 2 alphanumeric characters');
    }
    if (!params.password || params.password.length < 6) {
      throw new Error('Password must be at least 6 characters');
    }
    const existingHandle = this.db
      .prepare(`SELECT id FROM users WHERE LOWER(handle) = ?`)
      .get(cleanHandle) as { id: string } | undefined;
    if (existingHandle) {
      throw new Error(`Username "${cleanHandle}" is already taken`);
    }

    const email = (params.email?.trim() || `${cleanHandle}@local.skyday.eu`).toLowerCase();
    const existingEmail = this.db
      .prepare(`SELECT id FROM users WHERE LOWER(email) = ?`)
      .get(email) as { id: string } | undefined;
    if (existingEmail) {
      throw new Error(`Email "${email}" is already registered`);
    }

    const userId = `usr-${cleanHandle}-${crypto.randomUUID().slice(0, 4)}`;
    const personalWsId = `ws-${cleanHandle}-${crypto.randomUUID().slice(0, 4)}`;
    const displayName = params.displayName.trim() || cleanHandle;
    const defaultCurrency: CurrencyCode = params.defaultCurrency || 'GBP';
    const locale: LocaleCode = params.locale === 'pl' ? 'pl' : 'en';
    const pwdHash = hashPassword(params.password);
    const nowIso = new Date().toISOString();

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `INSERT INTO users (id, handle, display_name, email, default_currency, personal_workspace_id, auth_provider, password_hash, locale, is_admin, is_active, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'local', ?, ?, ?, 1, ?)`
        )
        .run(
          userId,
          cleanHandle,
          displayName,
          email,
          defaultCurrency,
          personalWsId,
          pwdHash,
          locale,
          params.isAdmin ? 1 : 0,
          nowIso
        );

      this.db
        .prepare(
          `INSERT INTO workspaces (id, slug, name, kind, owner_user_id, partner_visibility, default_split_mode, wadera_custom_split_bp)
           VALUES (?, ?, ?, 'personal', ?, 'private', 'owner_only', 0)`
        )
        .run(personalWsId, personalWsId, `${displayName} Personal`, userId);

      this.db
        .prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`)
        .run(personalWsId, userId, nowIso);

      if (Array.isArray(params.sharedWorkspaceGrants)) {
        const insGrant = this.db.prepare(
          `INSERT OR REPLACE INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`
        );
        for (const g of params.sharedWorkspaceGrants) {
          if (g.workspaceId && g.role) {
            insGrant.run(g.workspaceId, userId, g.role, nowIso);
          }
        }
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.getUserById(userId)!;
  }

  public getWorkspaces(): WorkspaceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, slug, name, kind, owner_user_id, partner_visibility, default_split_mode, wadera_custom_split_bp
         FROM workspaces
         ORDER BY CASE kind WHEN 'shared' THEN 0 WHEN 'company' THEN 1 ELSE 2 END, name ASC`
      )
      .all() as Array<{
      id: string;
      slug: string;
      name: string;
      kind: WorkspaceKind;
      owner_user_id: string | null;
      partner_visibility: PartnerVisibility;
      default_split_mode: SplitMode;
      wadera_custom_split_bp: number;
    }>;
    return rows.map((w) => ({
      id: w.id,
      slug: w.slug,
      name: w.name,
      kind: w.kind,
      ownerUserId: w.owner_user_id,
      partnerVisibility: w.partner_visibility,
      defaultSplitMode: w.default_split_mode,
      waderaCustomSplitBp: w.wadera_custom_split_bp,
    }));
  }

  public createWorkspace(params: {
    ownerUserId: string;
    name: string;
    kind: WorkspaceKind;
    sharedMembers?: Array<{ userId: string; role: WorkspaceRole }>;
  }): WorkspaceRecord {
    const name = params.name.trim();
    if (!name) throw new Error('Workspace name is required');
    const baseSlug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24) || 'workspace';
    const id = `ws-${baseSlug}-${crypto.randomUUID().slice(0, 5)}`;
    const kind: WorkspaceKind =
      params.kind === 'company' ? 'company' : params.kind === 'shared' ? 'shared' : 'personal';
    const splitMode: SplitMode = kind === 'shared' ? 'equal_50_50' : 'owner_only';
    const nowIso = new Date().toISOString();

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `INSERT INTO workspaces (id, slug, name, kind, owner_user_id, partner_visibility, default_split_mode, wadera_custom_split_bp)
           VALUES (?, ?, ?, ?, ?, 'private', ?, 5000)`
        )
        .run(id, id, name, kind, params.ownerUserId, splitMode);

      this.db
        .prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`)
        .run(id, params.ownerUserId, nowIso);

      if (Array.isArray(params.sharedMembers)) {
        const insMem = this.db.prepare(
          `INSERT OR REPLACE INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`
        );
        for (const m of params.sharedMembers) {
          if (m.userId && m.userId !== params.ownerUserId) {
            insMem.run(id, m.userId, m.role, nowIso);
          }
        }
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.getWorkspaces().find((w) => w.id === id)!;
  }

  public listWorkspaceMembers(workspaceId: string): WorkspaceMemberRecord[] {
    const rows = this.db
      .prepare(
        `SELECT wm.workspace_id, wm.user_id, wm.role, u.handle, u.display_name
         FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id
         WHERE wm.workspace_id = ? AND u.is_active = 1
         ORDER BY CASE wm.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 WHEN 'viewer' THEN 2 ELSE 3 END, u.display_name ASC`
      )
      .all(workspaceId) as Array<{
      workspace_id: string;
      user_id: string;
      role: WorkspaceRole;
      handle: string;
      display_name: string;
    }>;
    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      userId: r.user_id,
      handle: r.handle,
      displayName: r.display_name,
      role: r.role,
    }));
  }

  public setWorkspaceMember(workspaceId: string, userId: string, role: WorkspaceRole): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`)
      .run(workspaceId, userId, role, new Date().toISOString());
  }

  public removeWorkspaceMember(workspaceId: string, userId: string): void {
    this.db
      .prepare(`DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
      .run(workspaceId, userId);
  }

  public updateWorkspaceSettings(
    workspaceId: string,
    patch: {
      name?: string;
      kind?: WorkspaceKind;
      partnerVisibility?: PartnerVisibility;
      defaultSplitMode?: SplitMode;
      waderaCustomSplitBp?: number;
    }
  ): void {
    const current = this.getWorkspaces().find((w) => w.id === workspaceId);
    if (!current) return;
    this.db
      .prepare(
        `UPDATE workspaces
         SET name = ?, kind = ?, partner_visibility = ?, default_split_mode = ?, wadera_custom_split_bp = ?
         WHERE id = ?`
      )
      .run(
        patch.name?.trim() || current.name,
        patch.kind ?? current.kind,
        patch.partnerVisibility ?? current.partnerVisibility,
        patch.defaultSplitMode ?? current.defaultSplitMode,
        patch.waderaCustomSplitBp ?? current.waderaCustomSplitBp,
        workspaceId
      );
  }

  public getEffectiveWorkspaceRole(userId: string, workspaceId: string): WorkspaceRole | null {
    const ws = this.getWorkspaces().find((w) => w.id === workspaceId);
    if (!ws) return null;
    if (ws.ownerUserId === userId) return 'owner';

    const mem = this.db
      .prepare(`SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
      .get(workspaceId, userId) as { role: WorkspaceRole } | undefined;
    if (mem) return mem.role;

    // Household couple Partner Privacy Scope between Wadera & Walter on their personal workspaces
    const isHouseholdCouple =
      (userId === 'usr-wadera' || userId === 'usr-walter') &&
      (ws.ownerUserId === 'usr-wadera' || ws.ownerUserId === 'usr-walter') &&
      ws.kind === 'personal';
    if (isHouseholdCouple) {
      if (ws.partnerVisibility === 'readonly') return 'viewer';
      if (ws.partnerVisibility === 'totals_only') return 'totals_only';
      return null;
    }

    return null;
  }

  public canManageWorkspace(userId: string, workspaceId: string): boolean {
    const role = this.getEffectiveWorkspaceRole(userId, workspaceId);
    if (role === 'owner') return true;
    const u = this.getUserById(userId);
    if (workspaceId === 'ws-home' && u?.isAdmin) return true;
    return false;
  }

  public canReadWorkspaceItems(userId: string, workspaceId: string): boolean {
    const role = this.getEffectiveWorkspaceRole(userId, workspaceId);
    return role === 'owner' || role === 'editor' || role === 'viewer';
  }

  public canWriteWorkspace(userId: string, workspaceId: string): boolean {
    const role = this.getEffectiveWorkspaceRole(userId, workspaceId);
    return role === 'owner' || role === 'editor';
  }

  public canIncludeInCombinedWealth(userId: string, workspaceId: string): boolean {
    const role = this.getEffectiveWorkspaceRole(userId, workspaceId);
    return role !== null;
  }

  public readableWorkspaceIds(userId: string, scope: string): string[] {
    const user = this.getUserById(userId);
    if (!user) return [];
    const all = this.getWorkspaces();
    if (!scope || scope === 'all') {
      return all.filter((w) => this.canReadWorkspaceItems(userId, w.id)).map((w) => w.id);
    }
    if (scope === 'shared') {
      return all.filter((w) => w.kind === 'shared' && this.canReadWorkspaceItems(userId, w.id)).map((w) => w.id);
    }
    if (scope === 'company') {
      return all.filter((w) => w.kind === 'company' && this.canReadWorkspaceItems(userId, w.id)).map((w) => w.id);
    }
    if (scope === 'personal') {
      return this.canReadWorkspaceItems(userId, user.personalWorkspaceId) ? [user.personalWorkspaceId] : [];
    }
    if (scope === 'partner') {
      return all
        .filter((w) => w.kind === 'personal' && w.ownerUserId !== userId && this.canReadWorkspaceItems(userId, w.id))
        .map((w) => w.id);
    }
    // Specific workspace ID (e.g. 'ws-home', 'ws-wadera', 'ws-company-a', 'ws-company-b')
    return this.canReadWorkspaceItems(userId, scope) ? [scope] : [];
  }

  public mapAccountRow(r: Record<string, unknown>): BankAccountRecord {
    return {
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      name: String(r.name),
      institution: String(r.institution ?? ''),
      currency: r.currency as CurrencyCode,
      balanceMinor: Number(r.balance_minor),
      bookedBalanceMinor: r.booked_balance_minor != null ? Number(r.booked_balance_minor) : null,
      pendingDebitMinor: r.pending_debit_minor != null ? Number(r.pending_debit_minor) : null,
      pendingCreditMinor: r.pending_credit_minor != null ? Number(r.pending_credit_minor) : null,
      observedAt: (r.observed_at as string | null) ?? null,
      snapshotSource: (r.snapshot_source as string | null) ?? null,
      snapshotEvidence: (r.snapshot_evidence as string | null) ?? null,
      lastReconciledAt: (r.last_reconciled_at as string | null) ?? null,
      version: r.version != null ? Number(r.version) : 1,
      pocketMoneyTargetMinor: Number(r.pocket_money_target_minor ?? 0),
      isPrimaryRunway: Boolean(r.is_primary_runway),
      portalUrl: (r.portal_url as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      updatedAt: String(r.updated_at),
    };
  }

  public getAccountById(id: string): BankAccountRecord | null {
    const row = this.db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapAccountRow(row) : null;
  }

  public listAccounts(workspaceIds: string[]): BankAccountRecord[] {
    if (!workspaceIds.length) return [];
    const placeholders = workspaceIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM accounts WHERE workspace_id IN (${placeholders}) ORDER BY name`)
      .all(...workspaceIds) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapAccountRow(r));
  }

  public listIncomes(workspaceIds: string[]): IncomeStreamRecord[] {
    if (!workspaceIds.length) return [];
    const placeholders = workspaceIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM income_streams WHERE workspace_id IN (${placeholders}) ORDER BY effective_from DESC, name`)
      .all(...workspaceIds) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      accountId: (r.account_id as string | null) ?? null,
      name: String(r.name),
      sourceKind: r.source_kind as IncomeStreamRecord['sourceKind'],
      amountMinor: Number(r.amount_minor),
      currency: r.currency as CurrencyCode,
      cadence: r.cadence as IncomeStreamRecord['cadence'],
      paydayDay: Number(r.payday_day),
      effectiveFrom: String(r.effective_from),
      effectiveTo: (r.effective_to as string | null) ?? null,
      isActive: Boolean(r.is_active),
      portalUrl: (r.portal_url as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
    }));
  }

  public listPots(workspaceIds: string[]): PotRecord[] {
    if (!workspaceIds.length) return [];
    const placeholders = workspaceIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM pots WHERE workspace_id IN (${placeholders}) ORDER BY sort_order, name`)
      .all(...workspaceIds) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      parentId: (r.parent_id as string | null) ?? null,
      name: String(r.name),
      icon: String(r.icon ?? 'folder'),
      color: String(r.color ?? '#2E6F7E'),
      envelopeMode: Boolean(r.envelope_mode),
      monthlyEstimateMinor: Number(r.monthly_estimate_minor),
      currency: r.currency as CurrencyCode,
      tags: JSON.parse(String(r.tags_json || '[]')) as string[],
      sortOrder: Number(r.sort_order),
    }));
  }

  public mapObligationRow(r: Record<string, unknown>): ObligationRecord {
    return {
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      potId: (r.pot_id as string | null) ?? null,
      accountId: (r.account_id as string | null) ?? null,
      preserveAccountId: (r.preserve_account_id as string | null) ?? null,
      liabilityId: (r.liability_id as string | null) ?? null,
      name: String(r.name),
      amountMinor: Number(r.amount_minor),
      finalAmountMinor: r.final_amount_minor != null ? Number(r.final_amount_minor) : null,
      currency: r.currency as CurrencyCode,
      cadence: r.cadence as ObligationRecord['cadence'],
      intervalMonths: Number(r.interval_months),
      nextDueDate: String(r.next_due_date),
      endDate: (r.end_date as string | null) ?? null,
      remainingPayments: r.remaining_payments != null ? Number(r.remaining_payments) : null,
      dueDay: Number(r.due_day),
      preservedMinor: Number(r.preserved_minor),
      autoPreserve: Boolean(r.auto_preserve),
      splitMode: r.split_mode as SplitMode,
      waderaSplitBp: Number(r.wadera_split_bp),
      tags: JSON.parse(String(r.tags_json || '[]')) as string[],
      manageUrl: (r.manage_url as string | null) ?? null,
      portalUrl: (r.portal_url as string | null) ?? null,
      referenceNumber: (r.reference_number as string | null) ?? null,
      renewalNoticeDays: r.renewal_notice_days != null ? Number(r.renewal_notice_days) : null,
      notes: (r.notes as string | null) ?? null,
      isActive: Boolean(r.is_active),
    };
  }

  public getObligationById(id: string): ObligationRecord | null {
    const row = this.db.prepare(`SELECT * FROM obligations WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapObligationRow(row) : null;
  }

  public listObligations(workspaceIds: string[]): ObligationRecord[] {
    if (!workspaceIds.length) return [];
    const placeholders = workspaceIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM obligations WHERE workspace_id IN (${placeholders}) ORDER BY next_due_date, name`)
      .all(...workspaceIds) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapObligationRow(r));
  }

  public mapPaymentOccurrenceRow(r: Record<string, unknown>): PaymentOccurrenceRecord {
    return {
      id: String(r.id),
      obligationId: String(r.obligation_id),
      accountId: (r.account_id as string | null) ?? null,
      liabilityId: (r.liability_id as string | null) ?? null,
      liabilityDeltaMinor: Number(r.liability_delta_minor ?? 0),
      yearMonth: String(r.year_month),
      dueDate: String(r.due_date),
      expectedMinor: Number(r.expected_minor),
      actualPaidMinor: r.actual_paid_minor != null ? Number(r.actual_paid_minor) : null,
      currency: r.currency as CurrencyCode,
      status: r.status as PaymentOccurrenceRecord['status'],
      paidAt: (r.paid_at as string | null) ?? null,
      bankDate: (r.bank_date as string | null) ?? null,
      recordedAt: (r.recorded_at as string | null) ?? null,
      linkedTransactionId: (r.linked_transaction_id as string | null) ?? null,
      evidence: (r.evidence as string | null) ?? null,
      idempotencyKey: (r.idempotency_key as string | null) ?? null,
      balanceApplied: Boolean(r.balance_applied),
      notes: (r.notes as string | null) ?? null,
    };
  }

  public listPaymentOccurrences(yearMonth: string, obligationIds: string[]): PaymentOccurrenceRecord[] {
    if (!obligationIds.length) return [];
    const placeholders = obligationIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM payment_occurrences WHERE year_month = ? AND obligation_id IN (${placeholders}) ORDER BY due_date`
      )
      .all(yearMonth, ...obligationIds) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapPaymentOccurrenceRow(r));
  }

  public listIncomeOccurrences(
    yearMonth: string,
    incomeIds: string[]
  ): Array<{
    id: string;
    incomeId: string;
    accountId: string | null;
    yearMonth: string;
    expectedDate: string;
    receivedMinor: number;
    currency: CurrencyCode;
    status: 'received';
    receivedAt: string;
  }> {
    if (!incomeIds.length) return [];
    const placeholders = incomeIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM income_occurrences WHERE year_month = ? AND income_id IN (${placeholders}) ORDER BY expected_date`
      )
      .all(yearMonth, ...incomeIds) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      incomeId: String(r.income_id),
      accountId: (r.account_id as string | null) ?? null,
      yearMonth: String(r.year_month),
      expectedDate: String(r.expected_date),
      receivedMinor: Number(r.received_minor),
      currency: r.currency as CurrencyCode,
      status: 'received' as const,
      receivedAt: String(r.received_at),
    }));
  }

  public setIncomeReceived(params: {
    incomeId: string;
    accountId?: string | null;
    yearMonth: string;
    expectedDate: string;
    amountMinor: number;
    currency: CurrencyCode;
    received: boolean;
  }): void {
    if (params.received) {
      this.db
        .prepare(
          `INSERT INTO income_occurrences (id, income_id, account_id, year_month, expected_date, received_minor, currency, status, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?)
           ON CONFLICT(income_id, year_month) DO UPDATE SET
             account_id = excluded.account_id,
             received_minor = excluded.received_minor,
             status = 'received',
             received_at = excluded.received_at`
        )
        .run(
          `incocc-${crypto.randomUUID().slice(0, 8)}`,
          params.incomeId,
          params.accountId ?? null,
          params.yearMonth,
          params.expectedDate,
          params.amountMinor,
          params.currency,
          new Date().toISOString()
        );
    } else {
      this.db
        .prepare(`DELETE FROM income_occurrences WHERE income_id = ? AND year_month = ?`)
        .run(params.incomeId, params.yearMonth);
    }
  }

  public mapExpenseRow(r: Record<string, unknown>): ExpenseEntryRecord {
    const flowDirection = r.flow_direction === 'inflow' ? 'inflow' : 'outflow';
    const rawKind = r.kind as TransactionKind | null | undefined;
    const kind: TransactionKind =
      rawKind === 'transfer'
        ? 'transfer'
        : rawKind === 'deposit' || flowDirection === 'inflow'
          ? 'deposit'
          : 'expense';
    const rawStatus = r.status as TransactionStatus | null | undefined;
    const status: TransactionStatus =
      rawStatus === 'pending' || rawStatus === 'reversed' || rawStatus === 'refunded' ? rawStatus : 'posted';
    return {
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      potId: (r.pot_id as string | null) ?? null,
      accountId: (r.account_id as string | null) ?? null,
      liabilityId: (r.liability_id as string | null) ?? null,
      flowDirection,
      kind,
      status,
      merchant: String(r.merchant),
      description: String(r.description ?? ''),
      amountMinor: Number(r.amount_minor),
      currency: r.currency as CurrencyCode,
      originalAmountMinor: r.original_amount_minor != null ? Number(r.original_amount_minor) : null,
      originalCurrency: (r.original_currency as CurrencyCode | null) ?? null,
      fxRate: r.fx_rate != null ? Number(r.fx_rate) : null,
      feeMinor: r.fee_minor != null ? Number(r.fee_minor) : null,
      spentDate: String(r.spent_date),
      bankTimestamp: (r.bank_timestamp as string | null) ?? (String(r.spent_date).includes('T') ? String(r.spent_date) : null),
      observedAt: (r.observed_at as string | null) ?? null,
      reference: (r.reference as string | null) ?? null,
      evidence: (r.evidence as string | null) ?? null,
      providerTxId: (r.provider_tx_id as string | null) ?? null,
      idempotencyKey: (r.idempotency_key as string | null) ?? null,
      transferId: (r.transfer_id as string | null) ?? null,
      transferPeerId: (r.transfer_peer_id as string | null) ?? null,
      transferPeerAccountId: (r.transfer_peer_account_id as string | null) ?? null,
      availableApplied: r.available_applied == null ? true : Boolean(r.available_applied),
      bookedApplied: r.booked_applied == null ? status === 'posted' : Boolean(r.booked_applied),
      tags: JSON.parse(String(r.tags_json || '[]')) as string[],
      portalUrl: (r.portal_url as string | null) ?? null,
      source: r.source as ExpenseEntryRecord['source'],
      items: JSON.parse(String(r.items_json || '[]')) as ExpenseSubItem[],
      createdAt: String(r.created_at),
      updatedAt: (r.updated_at as string | null) ?? String(r.created_at),
    };
  }

  public getExpenseById(id: string): ExpenseEntryRecord | null {
    const row = this.db.prepare(`SELECT * FROM expenses WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapExpenseRow(row) : null;
  }

  public listExpenses(workspaceIds: string[], fromYm?: string, toYm?: string): ExpenseEntryRecord[] {
    if (!workspaceIds.length) return [];
    const placeholders = workspaceIds.map(() => '?').join(',');
    let sql = `SELECT * FROM expenses WHERE workspace_id IN (${placeholders})`;
    const args: Array<string | number> = [...workspaceIds];
    if (fromYm) {
      sql += ` AND substr(spent_date, 1, 7) >= ?`;
      args.push(fromYm);
    }
    if (toYm) {
      sql += ` AND substr(spent_date, 1, 7) <= ?`;
      args.push(toYm);
    }
    sql += ` ORDER BY COALESCE(bank_timestamp, spent_date) DESC, created_at DESC, id DESC`;
    const rows = this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapExpenseRow(r));
  }

  public listAssets(workspaceIds: string[]): AssetBelongingRecord[] {
    if (!workspaceIds.length) return [];
    const placeholders = workspaceIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM assets WHERE workspace_id IN (${placeholders}) ORDER BY current_value_minor DESC, name`)
      .all(...workspaceIds) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      name: String(r.name),
      assetClass: r.asset_class as AssetBelongingRecord['assetClass'],
      purchaseDate: (r.purchase_date as string | null) ?? null,
      purchasePriceMinor: Number(r.purchase_price_minor),
      currentValueMinor: Number(r.current_value_minor),
      currency: r.currency as CurrencyCode,
      curveModel: r.curve_model as AssetBelongingRecord['curveModel'],
      annualRateBp: Number(r.annual_rate_bp),
      residualFloorMinor: Number(r.residual_floor_minor),
      portalUrl: (r.portal_url as string | null) ?? null,
      manageUrl: (r.manage_url as string | null) ?? null,
      referenceNumber: (r.reference_number as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      updatedAt: String(r.updated_at),
    }));
  }

  public listLiabilities(workspaceIds: string[]): LiabilityRecord[] {
    if (!workspaceIds.length) return [];
    const placeholders = workspaceIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM liabilities WHERE workspace_id IN (${placeholders}) ORDER BY balance_minor DESC, name`)
      .all(...workspaceIds) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      linkedAssetId: (r.linked_asset_id as string | null) ?? null,
      name: String(r.name),
      kind: r.kind as LiabilityRecord['kind'],
      balanceMinor: Number(r.balance_minor),
      aprBp: Number(r.apr_bp),
      monthlyPaymentMinor: Number(r.monthly_payment_minor),
      currency: r.currency as CurrencyCode,
      endDate: (r.end_date as string | null) ?? null,
      portalUrl: (r.portal_url as string | null) ?? null,
      referenceNumber: (r.reference_number as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      updatedAt: String(r.updated_at),
    }));
  }

  public listSnapshots(workspaceIds: string[]): WealthSnapshotRecord[] {
    if (!workspaceIds.length) return [];
    const placeholders = workspaceIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM wealth_snapshots WHERE workspace_id IN (${placeholders}) ORDER BY snapshot_date ASC`)
      .all(...workspaceIds) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      snapshotDate: String(r.snapshot_date),
      totalAssetsGbpMinor: Number(r.total_assets_gbp_minor),
      totalLiabilitiesGbpMinor: Number(r.total_liabilities_gbp_minor),
      netWorthGbpMinor: Number(r.net_worth_gbp_minor),
      grossAnnualIncomeGbpMinor: r.gross_annual_income_gbp_minor != null ? Number(r.gross_annual_income_gbp_minor) : null,
      note: (r.note as string | null) ?? null,
    }));
  }

  public listAttachments(workspaceIds: string[], entityType?: string, entityId?: string): AttachmentRecord[] {
    if (!workspaceIds.length) return [];
    const placeholders = workspaceIds.map(() => '?').join(',');
    let sql = `SELECT * FROM attachments WHERE workspace_id IN (${placeholders})`;
    const args: string[] = [...workspaceIds];
    if (entityType) {
      sql += ` AND entity_type = ?`;
      args.push(entityType);
    }
    if (entityId) {
      sql += ` AND entity_id = ?`;
      args.push(entityId);
    }
    sql += ` ORDER BY created_at DESC`;
    const rows = this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      entityType: r.entity_type as AttachmentRecord['entityType'],
      entityId: String(r.entity_id),
      originalName: String(r.original_name),
      mimeType: String(r.mime_type),
      sizeBytes: Number(r.size_bytes),
      sha256: String(r.sha256),
      label: (r.label as string | null) ?? null,
      createdAt: String(r.created_at),
    }));
  }

  public createBackupSnapshot(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(this.paths.backupsDir, `skyday-finance-${stamp}.sqlite`);
    const escaped = outPath.replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${escaped}'`);
    return outPath;
  }

  public clearAllFinancialRecords(): void {
    this.db.exec(`
      DELETE FROM reconciliation_batches;
      DELETE FROM account_transfers;
      DELETE FROM income_occurrences;
      DELETE FROM payment_occurrences;
      DELETE FROM expenses;
      DELETE FROM obligations;
      DELETE FROM pots;
      DELETE FROM income_streams;
      DELETE FROM accounts;
      DELETE FROM liabilities;
      DELETE FROM assets;
      DELETE FROM wealth_snapshots;
    `);
  }

  public loadStarterHouseholdSample(): void {
    this.clearAllFinancialRecords();
    const now = '2026-11-04T12:00:00Z';

    // Bank Accounts
    const insAcc = this.db.prepare(`
      INSERT INTO accounts (id, workspace_id, name, institution, currency, balance_minor, is_primary_runway, portal_url, notes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insAcc.run('acc-home-joint', 'ws-home', 'Household Bills Account', 'Monzo Joint', 'GBP', 345000, 1, 'https://monzo.com', 'Shared bills & food', now);
    insAcc.run('acc-wadera-main', 'ws-wadera', 'Wadera Current & Preserve Vaults', 'Starling Bank', 'GBP', 682000, 1, 'https://starlingbank.com', 'Main personal + sinking reserves', now);
    insAcc.run('acc-wadera-pln', 'ws-wadera', 'Poland PLN Account', 'mBank', 'PLN', 840000, 0, 'https://mbank.pl', 'PLN travel & family account (8,400 zł)', now);
    insAcc.run('acc-walter-main', 'ws-walter', 'Walter Current Account', 'HSBC UK', 'GBP', 510000, 1, 'https://hsbc.co.uk', null, now);

    // Income Streams (including historical salary progression)
    const insInc = this.db.prepare(`
      INSERT INTO income_streams (id, workspace_id, name, source_kind, amount_minor, currency, cadence, payday_day, effective_from, effective_to, is_active, portal_url, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insInc.run('inc-wadera-2017', 'ws-wadera', 'Senior Engineering Role (2017–2020)', 'salary', 385000, 'GBP', 'monthly', 27, '2016-01-01', '2020-12-31', 1, null, 'Historical career band');
    insInc.run('inc-wadera-2021', 'ws-wadera', 'Staff Engineering Role (2021–2023)', 'salary', 455000, 'GBP', 'monthly', 27, '2021-01-01', '2023-12-31', 1, null, 'Historical career band');
    insInc.run('inc-wadera-2024', 'ws-wadera', 'Principal Engineering Salary (2024)', 'salary', 510000, 'GBP', 'monthly', 27, '2024-01-01', '2025-03-31', 1, null, 'Previous role band');
    insInc.run('inc-wadera-cur', 'ws-wadera', 'Net Monthly Salary (Wadera)', 'salary', 595000, 'GBP', 'monthly', 27, '2025-04-01', null, 1, null, 'Primary take-home (27th payday)');
    insInc.run('inc-walter-cur', 'ws-walter', 'Net Monthly Salary (Walter)', 'salary', 465000, 'GBP', 'monthly', 28, '2025-01-01', null, 1, null, 'Primary take-home');

    // Hierarchical Pots
    const insPot = this.db.prepare(`
      INSERT INTO pots (id, workspace_id, parent_id, name, icon, color, envelope_mode, monthly_estimate_minor, currency, tags_json, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Shared Household Pots
    insPot.run('pot-housing', 'ws-home', null, 'Home & Utilities', 'home', '#2E6F7E', 0, 0, 'GBP', '["home","shared"]', 1);
    insPot.run('pot-food', 'ws-home', 'pot-housing', 'Food & Groceries', 'shopping-bag', '#3D7A5A', 1, 60000, 'GBP', '["groceries","shared"]', 2);
    insPot.run('pot-food-meat', 'ws-home', 'pot-food', 'Butcher & Meat', 'utensils', '#4E8C6B', 0, 0, 'GBP', '["meat"]', 1);
    insPot.run('pot-food-dairy', 'ws-home', 'pot-food', 'Butter, Bakery & Essentials', 'coffee', '#5F9E7D', 0, 0, 'GBP', '["dairy"]', 2);
    insPot.run('pot-subs-home', 'ws-home', null, 'Shared Subscriptions', 'tv', '#6E5A7E', 0, 0, 'GBP', '["subscriptions","shared"]', 3);
    insPot.run('pot-vacation', 'ws-home', null, 'Vacations & Travel', 'plane', '#C87D32', 0, 0, 'GBP', '["vacations","sinking"]', 4);

    // Wadera Personal Pots
    insPot.run('pot-vehicles', 'ws-wadera', null, 'Car & Moto Fleet', 'car', '#2B5B84', 0, 0, 'GBP', '["car","moto"]', 1);
    insPot.run('pot-fuel', 'ws-wadera', 'pot-vehicles', 'Fuel & Charging', 'fuel', '#3A6F9E', 1, 30000, 'GBP', '["fuel"]', 1);
    insPot.run('pot-veh-maint', 'ws-wadera', 'pot-vehicles', 'Insurance & Servicing', 'shield', '#4A82B4', 0, 0, 'GBP', '["insurance","maintenance"]', 2);
    insPot.run('pot-ai-hobbies', 'ws-wadera', null, 'AI Lab & Hobbies', 'cpu', '#7A5195', 0, 0, 'GBP', '["ai","hobbies","homelab"]', 2);

    // Scheduled Obligations (Monthly Bills + Multi-Month Sinking 'Preserve' Goals + Multi-Currency)
    const insOb = this.db.prepare(`
      INSERT INTO obligations (
        id, workspace_id, pot_id, name, amount_minor, currency, cadence, interval_months,
        next_due_date, due_day, preserved_minor, auto_preserve, split_mode, wadera_split_bp,
        tags_json, manage_url, portal_url, reference_number, renewal_notice_days, notes, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insOb.run(
      'ob-mortgage', 'ws-home', 'pot-housing', 'House Mortgage Payment', 168000, 'GBP', 'monthly', 1,
      '2026-11-01', 1, 0, 0, 'equal_50_50', 5000, '["housing","mortgage"]',
      'https://nationwide.co.uk', 'https://nationwide.co.uk', 'MTG-88412', 90, 'Fixed rate until 2028', 1
    );
    insOb.run(
      'ob-energy', 'ws-home', 'pot-housing', 'Electricity & Gas (Octopus)', 21500, 'GBP', 'monthly', 1,
      '2026-11-12', 12, 0, 0, 'equal_50_50', 5000, '["utilities","electricity","gas"]',
      'https://octopus.energy/dashboard', 'https://octopus.energy', 'OCT-4419', null, 'Smart tariff', 1
    );
    insOb.run(
      'ob-council', 'ws-home', 'pot-housing', 'Council Tax & Water', 24000, 'GBP', 'monthly', 1,
      '2026-11-15', 15, 0, 0, 'equal_50_50', 5000, '["utilities"]',
      null, null, 'CT-2026', null, null, 1
    );
    insOb.run(
      'ob-netflix', 'ws-home', 'pot-subs-home', 'Netflix + Spotify Duo', 2898, 'GBP', 'monthly', 1,
      '2026-11-18', 18, 0, 0, 'equal_50_50', 5000, '["subscriptions","streaming"]',
      'https://www.netflix.com/youraccount', null, null, 7, 'Cancel or downgrade anytime', 1
    );
    insOb.run(
      'ob-alps-trip', 'ws-home', 'pot-vacation', 'Alps Ski & MTB Trip (One-Time Goal)', 180000, 'EUR', 'once', 0,
      '2027-02-20', 20, 30000, 1, 'equal_50_50', 5000, '["vacations","sinking"]',
      'https://booking.com', null, 'BK-ALPS-27', 14, '€1,800 target (€300 already preserved -> €500/mo split across 3 months)', 1
    );
    insOb.run(
      'ob-car-ins', 'ws-wadera', 'pot-veh-maint', 'Car Insurance Renewal', 72000, 'GBP', 'annual', 12,
      '2027-02-10', 10, 27000, 1, 'owner_only', 10000, '["car","insurance","sinking"]',
      'https://www.admiral.com/myaccount', 'https://www.admiral.com', 'ADM-99201', 30, '£720 due in 3m, £270 preserved -> £150/mo now; resets to £60/mo over 12m after payment', 1
    );
    insOb.run(
      'ob-moto-service', 'ws-wadera', 'pot-veh-maint', 'Motorcycle Annual Service & Tyres', 45000, 'GBP', 'annual', 12,
      '2027-02-25', 25, 30000, 1, 'owner_only', 10000, '["moto","maintenance","sinking"]',
      null, null, null, 14, '£150 remaining over 3 months -> £50/mo preserve slice', 1
    );
    insOb.run(
      'ob-ai-stack', 'ws-wadera', 'pot-ai-hobbies', 'AI Coding & Inference Subscriptions', 16000, 'USD', 'monthly', 1,
      '2026-11-22', 22, 0, 0, 'owner_only', 10000, '["ai","subscriptions"]',
      'https://console.anthropic.com/settings/billing', 'https://platform.openai.com/settings', null, 5, 'Billed in USD ($160/mo -> auto-converted to GBP)', 1
    );
    insOb.run(
      'ob-domain-eu', 'ws-wadera', 'pot-ai-hobbies', 'Homelab Domains & Relay Cloud', 14400, 'EUR', 'annual', 12,
      '2027-05-14', 14, 0, 1, 'owner_only', 10000, '["homelab","subscriptions","sinking"]',
      'https://dash.cloudflare.com', null, 'CF-SKYDAY', 30, '€144/yr auto-preserved monthly', 1
    );

    // Mark Nov 1st mortgage as already paid to showcase live Timeline checklist progress
    this.db
      .prepare(
        `INSERT INTO payment_occurrences (id, obligation_id, year_month, due_date, expected_minor, actual_paid_minor, currency, status, paid_at, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?)`
      )
      .run('occ-mort-2026-11', 'ob-mortgage', '2026-11', '2026-11-01', 168000, 168000, 'GBP', '2026-11-01T09:00:00Z', 'Direct debit cleared');

    // Sample Expenses (with sub-item granularity + historical months for clean 6-month trend)
    const insExp = this.db.prepare(`
      INSERT INTO expenses (id, workspace_id, pot_id, merchant, description, amount_minor, currency, spent_date, tags_json, portal_url, source, items_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insExp.run(
      'exp-waitrose-1',
      'ws-home',
      'pot-food',
      'Waitrose & Partners',
      'Weekly household shop (itemized sub-pots)',
      11840,
      'GBP',
      '2026-11-02',
      '["groceries","shared"]',
      null,
      'manual',
      JSON.stringify([
        { id: 'i1', name: 'Organic Ribeye & Chicken', subCategory: 'Meat', amountMinor: 4250 },
        { id: 'i2', name: 'Kerrygold Butter, Sourdough & Milk', subCategory: 'Butter & Bakery', amountMinor: 1890 },
        { id: 'i3', name: 'Produce & Pantry', subCategory: 'Vegetables', amountMinor: 5700 },
      ]),
      now
    );
    insExp.run(
      'exp-shell-1',
      'ws-wadera',
      'pot-fuel',
      'Shell V-Power',
      'Tank fill-up',
      7420,
      'GBP',
      '2026-11-03',
      '["fuel","car"]',
      null,
      'manual',
      '[]',
      now
    );
    // Prior months for 6-month spending context
    const histMonths: Array<[string, number, number]> = [
      ['2026-06-15', 56200, 26500],
      ['2026-07-15', 58900, 29000],
      ['2026-08-15', 63400, 31500],
      ['2026-09-15', 57100, 27800],
      ['2026-10-15', 59400, 28400],
    ];
    histMonths.forEach(([dt, foodMinor, fuelMinor], idx) => {
      insExp.run(`exp-hist-food-${idx}`, 'ws-home', 'pot-food', 'Monthly Groceries', 'Historical grocery spend', foodMinor, 'GBP', dt, '["groceries"]', null, 'manual', '[]', now);
      insExp.run(`exp-hist-fuel-${idx}`, 'ws-wadera', 'pot-fuel', 'Monthly Fuel', 'Historical fuel spend', fuelMinor, 'GBP', dt, '["fuel"]', null, 'manual', '[]', now);
    });

    // Wealth & Belongings Registry (Appreciating House + Depreciating Vehicles/E-MTB/PC)
    const insAsset = this.db.prepare(`
      INSERT INTO assets (
        id, workspace_id, name, asset_class, purchase_date, purchase_price_minor, current_value_minor,
        currency, curve_model, annual_rate_bp, residual_floor_minor, portal_url, manage_url, reference_number, notes, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insAsset.run(
      'ast-house', 'ws-home', 'Family Home (UK)', 'property', '2022-09-01', 43500000, 48500000,
      'GBP', 'compound_annual', 350, 0, 'https://zoopla.co.uk', null, 'TITLE-UK-402', 'Appreciating ~3.5%/yr', now
    );
    insAsset.run(
      'ast-car', 'ws-wadera', 'Daily Car', 'vehicle', '2023-05-15', 2950000, 2180000,
      'GBP', 'compound_annual', -1400, 450000, null, 'https://www.admiral.com', null, 'Depreciating ~14%/yr', now
    );
    insAsset.run(
      'ast-moto', 'ws-wadera', 'Adventure Motorcycle', 'vehicle', '2024-04-10', 1380000, 1120000,
      'GBP', 'compound_annual', -1100, 350000, null, null, null, 'Depreciating ~11%/yr', now
    );
    insAsset.run(
      'ast-emtb', 'ws-wadera', 'Carbon Electric Mountain Bike (E-MTB)', 'belonging', '2025-03-01', 640000, 490000,
      'GBP', 'compound_annual', -1800, 120000, null, null, 'FRAME-EMTB-9', 'Depreciating ~18%/yr', now
    );
    insAsset.run(
      'ast-pc', 'ws-wadera', 'PC Turbo Workstation & Homelab Rack', 'belonging', '2025-08-01', 480000, 385000,
      'GBP', 'compound_annual', -2200, 75000, null, null, null, 'GPU workstation + Monolith/AI servers', now
    );
    insAsset.run(
      'ast-isa-wadera', 'ws-wadera', 'Stocks & Shares ISA', 'investment', '2021-04-06', 3200000, 4150000,
      'GBP', 'compound_annual', 650, 0, 'https://vanguardinvestor.co.uk', null, null, 'Global index tracker (+6.5%/yr est.)', now
    );
    insAsset.run(
      'ast-walter-isa', 'ws-walter', 'Walter Savings & ISA', 'investment', '2022-04-06', 2400000, 2950000,
      'GBP', 'compound_annual', 600, 0, null, null, null, null, now
    );

    // Liabilities (Mortgage + 0% Credit Card)
    const insLiab = this.db.prepare(`
      INSERT INTO liabilities (
        id, workspace_id, linked_asset_id, name, kind, balance_minor, apr_bp,
        monthly_payment_minor, currency, end_date, portal_url, reference_number, notes, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insLiab.run(
      'liab-mortgage', 'ws-home', 'ast-house', 'Nationwide House Mortgage', 'mortgage', 28400000, 415,
      168000, 'GBP', '2047-09-01', 'https://nationwide.co.uk', 'MTG-88412', '4.15% APR', now
    );
    insLiab.run(
      'liab-wadera-cc', 'ws-wadera', null, 'Equipment 0% Promo Card', 'credit_card', 180000, 0,
      30000, 'GBP', '2027-05-01', null, null, '0% promotional balance cleared £300/mo', now
    );

    // Historical Wealth Snapshots (Combined & Personal trajectory)
    const insSnap = this.db.prepare(`
      INSERT INTO wealth_snapshots (id, workspace_id, snapshot_date, total_assets_gbp_minor, total_liabilities_gbp_minor, net_worth_gbp_minor, gross_annual_income_gbp_minor, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insSnap.run('snap-home-2024', 'ws-home', '2024-01-01', 45200000, 30400000, 14800000, null, '2024 start');
    insSnap.run('snap-home-2025', 'ws-home', '2025-01-01', 46800000, 29450000, 17350000, null, '2025 start');
    insSnap.run('snap-home-2026', 'ws-home', '2026-01-01', 48100000, 28750000, 19350000, null, '2026 start');

    insSnap.run('snap-wad-2024', 'ws-wadera', '2024-01-01', 6400000, 420000, 5980000, 7800000, '2024 review');
    insSnap.run('snap-wad-2025', 'ws-wadera', '2025-01-01', 7850000, 290000, 7560000, 8800000, '2025 promotion');
    insSnap.run('snap-wad-2026', 'ws-wadera', '2026-01-01', 8920000, 210000, 8710000, 9600000, '2026 start');

    insSnap.run('snap-wal-2024', 'ws-walter', '2024-01-01', 2400000, 0, 2400000, 6500000, '2024 start');
    insSnap.run('snap-wal-2025', 'ws-walter', '2025-01-01', 2950000, 0, 2950000, 7000000, '2025 start');
    insSnap.run('snap-wal-2026', 'ws-walter', '2026-01-01', 3460000, 0, 3460000, 7200000, '2026 start');
    this.backfillDefaultAccountLinks();
  }

  public createApiKey(userId: string, label: string): { id: string; rawToken: string; keyPrefix: string } {
    const id = `key-${crypto.randomUUID().slice(0, 8)}`;
    const secretPart = crypto.randomBytes(24).toString('base64url');
    const rawToken = `skf_${secretPart}`;
    const keyPrefix = rawToken.slice(0, 10);
    const keySha256 = crypto.createHash('sha256').update(rawToken).digest('hex');
    this.db
      .prepare(
        `INSERT INTO agent_api_keys (id, user_id, label, key_prefix, key_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, userId, label, keyPrefix, keySha256, new Date().toISOString());
    return { id, rawToken, keyPrefix };
  }

  public verifyApiKey(rawToken: string): UserProfile | null {
    if (!rawToken.startsWith('skf_')) return null;
    const keySha256 = crypto.createHash('sha256').update(rawToken).digest('hex');
    const row = this.db
      .prepare(`SELECT id, user_id FROM agent_api_keys WHERE key_sha256 = ? AND revoked_at IS NULL`)
      .get(keySha256) as { id: string; user_id: string } | undefined;
    if (!row) return null;
    this.db.prepare(`UPDATE agent_api_keys SET last_used_at = ? WHERE id = ?`).run(new Date().toISOString(), row.id);
    return this.getUserById(row.user_id);
  }

  public listApiKeys(userId: string): Array<{
    id: string;
    label: string;
    keyPrefix: string;
    createdAt: string;
    lastUsedAt: string | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, label, key_prefix, created_at, last_used_at
         FROM agent_api_keys
         WHERE user_id = ? AND revoked_at IS NULL
         ORDER BY created_at DESC`
      )
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      label: String(r.label),
      keyPrefix: String(r.key_prefix),
      createdAt: String(r.created_at),
      lastUsedAt: (r.last_used_at as string | null) ?? null,
    }));
  }

  public revokeApiKey(userId: string, keyId: string): void {
    this.db
      .prepare(`UPDATE agent_api_keys SET revoked_at = ? WHERE id = ? AND user_id = ?`)
      .run(new Date().toISOString(), keyId, userId);
  }

  // ===========================================================================
  // 1. Account Patching, Balance Snapshots & Enriched Sufficiency
  // ===========================================================================

  public upsertAccount(input: {
    id?: string;
    workspaceId?: string;
    name?: string;
    institution?: string;
    currency?: CurrencyCode;
    balanceMinor?: number;
    bookedBalanceMinor?: number | null;
    pendingDebitMinor?: number | null;
    pendingCreditMinor?: number | null;
    observedAt?: string | null;
    snapshotSource?: string | null;
    snapshotEvidence?: string | null;
    lastReconciledAt?: string | null;
    pocketMoneyTargetMinor?: number;
    isPrimaryRunway?: boolean;
    portalUrl?: string | null;
    notes?: string | null;
  }): BankAccountRecord {
    const existing = input.id ? this.getAccountById(input.id) : null;
    const nowIso = new Date().toISOString();

    if (existing) {
      const nextWorkspaceId = input.workspaceId ?? existing.workspaceId;
      const nextName = input.name !== undefined ? input.name.trim() || existing.name : existing.name;
      const nextInstitution = input.institution !== undefined ? input.institution : existing.institution;
      const nextCurrency = input.currency ?? existing.currency;
      const nextBalanceMinor = input.balanceMinor !== undefined ? Math.round(input.balanceMinor) : existing.balanceMinor;
      const nextBookedMinor =
        input.bookedBalanceMinor !== undefined
          ? input.bookedBalanceMinor != null
            ? Math.round(input.bookedBalanceMinor)
            : null
          : (existing.bookedBalanceMinor ?? null);
      const nextPendingDebit =
        input.pendingDebitMinor !== undefined
          ? input.pendingDebitMinor != null
            ? Math.round(input.pendingDebitMinor)
            : null
          : (existing.pendingDebitMinor ?? null);
      const nextPendingCredit =
        input.pendingCreditMinor !== undefined
          ? input.pendingCreditMinor != null
            ? Math.round(input.pendingCreditMinor)
            : null
          : (existing.pendingCreditMinor ?? null);
      const nextObservedAt = input.observedAt !== undefined ? input.observedAt : (existing.observedAt ?? null);
      const nextSource = input.snapshotSource !== undefined ? input.snapshotSource : (existing.snapshotSource ?? null);
      const nextEvidence =
        input.snapshotEvidence !== undefined ? input.snapshotEvidence : (existing.snapshotEvidence ?? null);
      const nextReconciledAt =
        input.lastReconciledAt !== undefined ? input.lastReconciledAt : (existing.lastReconciledAt ?? null);
      const nextPocketTarget =
        input.pocketMoneyTargetMinor !== undefined
          ? Math.round(input.pocketMoneyTargetMinor)
          : (existing.pocketMoneyTargetMinor ?? 0);
      const nextPrimaryRunway =
        input.isPrimaryRunway !== undefined ? (input.isPrimaryRunway ? 1 : 0) : existing.isPrimaryRunway ? 1 : 0;
      const nextPortalUrl = input.portalUrl !== undefined ? input.portalUrl : existing.portalUrl;
      // Preserve existing notes when input.notes is omitted (undefined)!
      const nextNotes = input.notes !== undefined ? input.notes : existing.notes;
      const nextVersion = (existing.version ?? 1) + 1;

      this.db
        .prepare(
          `UPDATE accounts
           SET workspace_id = ?,
               name = ?,
               institution = ?,
               currency = ?,
               balance_minor = ?,
               booked_balance_minor = ?,
               pending_debit_minor = ?,
               pending_credit_minor = ?,
               observed_at = ?,
               snapshot_source = ?,
               snapshot_evidence = ?,
               last_reconciled_at = ?,
               pocket_money_target_minor = ?,
               is_primary_runway = ?,
               portal_url = ?,
               notes = ?,
               version = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          nextWorkspaceId,
          nextName,
          nextInstitution,
          nextCurrency,
          nextBalanceMinor,
          nextBookedMinor,
          nextPendingDebit,
          nextPendingCredit,
          nextObservedAt,
          nextSource,
          nextEvidence,
          nextReconciledAt,
          nextPocketTarget,
          nextPrimaryRunway,
          nextPortalUrl,
          nextNotes,
          nextVersion,
          nowIso,
          existing.id
        );
      return this.getAccountById(existing.id)!;
    }

    const id = input.id || `acc-${crypto.randomUUID().slice(0, 8)}`;
    const workspaceId = input.workspaceId || 'ws-home';
    const name = (input.name || 'Account').trim();
    const institution = input.institution ?? '';
    const currency: CurrencyCode = input.currency || 'GBP';
    const balanceMinor = Math.round(input.balanceMinor ?? 0);
    const bookedBalanceMinor = input.bookedBalanceMinor != null ? Math.round(input.bookedBalanceMinor) : null;
    const pendingDebitMinor = input.pendingDebitMinor != null ? Math.round(input.pendingDebitMinor) : null;
    const pendingCreditMinor = input.pendingCreditMinor != null ? Math.round(input.pendingCreditMinor) : null;
    const observedAt = input.observedAt ?? null;
    const snapshotSource = input.snapshotSource ?? null;
    const snapshotEvidence = input.snapshotEvidence ?? null;
    const lastReconciledAt = input.lastReconciledAt ?? null;
    const pocketMoneyTargetMinor = Math.round(input.pocketMoneyTargetMinor ?? 0);
    const isPrimaryRunway = input.isPrimaryRunway === false ? 0 : 1;
    const portalUrl = input.portalUrl ?? null;
    const notes = input.notes ?? null;

    this.db
      .prepare(
        `INSERT INTO accounts (
           id, workspace_id, name, institution, currency, balance_minor,
           booked_balance_minor, pending_debit_minor, pending_credit_minor,
           observed_at, snapshot_source, snapshot_evidence, last_reconciled_at,
           pocket_money_target_minor, is_primary_runway, portal_url, notes, version, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      )
      .run(
        id,
        workspaceId,
        name,
        institution,
        currency,
        balanceMinor,
        bookedBalanceMinor,
        pendingDebitMinor,
        pendingCreditMinor,
        observedAt,
        snapshotSource,
        snapshotEvidence,
        lastReconciledAt,
        pocketMoneyTargetMinor,
        isPrimaryRunway,
        portalUrl,
        notes,
        nowIso
      );
    return this.getAccountById(id)!;
  }

  public setAccountBalanceSnapshot(params: {
    accountId: string;
    availableBalanceMinor?: number;
    balanceMinor?: number;
    bookedBalanceMinor?: number | null;
    pendingDebitMinor?: number | null;
    pendingCreditMinor?: number | null;
    observedAt?: string;
    source?: string;
    evidence?: string;
    reconciled?: boolean;
    notes?: string;
    expectedVersion?: number;
  }): {
    before: BankAccountRecord;
    after: BankAccountRecord;
  } {
    const existing = this.getAccountById(params.accountId);
    if (!existing) {
      throw new Error(`Account "${params.accountId}" not found`);
    }
    if (params.expectedVersion !== undefined && (existing.version ?? 1) !== params.expectedVersion) {
      throw new Error(
        `Version conflict on account "${existing.name}" (${existing.id}): expected version ${params.expectedVersion}, actual ${existing.version ?? 1}`
      );
    }

    const nowIso = new Date().toISOString();
    const observedAt = params.observedAt || nowIso;
    const nextAvailable =
      params.availableBalanceMinor !== undefined
        ? Math.round(params.availableBalanceMinor)
        : params.balanceMinor !== undefined
          ? Math.round(params.balanceMinor)
          : existing.balanceMinor;

    const after = this.upsertAccount({
      id: existing.id,
      balanceMinor: nextAvailable,
      bookedBalanceMinor: params.bookedBalanceMinor,
      pendingDebitMinor: params.pendingDebitMinor,
      pendingCreditMinor: params.pendingCreditMinor,
      observedAt,
      snapshotSource: params.source !== undefined ? params.source : existing.snapshotSource,
      snapshotEvidence: params.evidence !== undefined ? params.evidence : existing.snapshotEvidence,
      lastReconciledAt: params.reconciled !== false ? observedAt : existing.lastReconciledAt,
      notes: params.notes, // undefined leaves existing.notes untouched!
    });

    return { before: existing, after };
  }

  public getAccountEnriched(accountId: string, yearMonth?: string) {
    const acc = this.getAccountById(accountId);
    if (!acc) return null;
    return this.enrichAccounts([acc], yearMonth)[0] ?? null;
  }

  public listAccountsEnriched(workspaceIds: string[], yearMonth?: string) {
    const accounts = this.listAccounts(workspaceIds);
    return this.enrichAccounts(accounts, yearMonth);
  }

  private enrichAccounts(accounts: BankAccountRecord[], yearMonth?: string) {
    if (!accounts.length) return [];
    const ym = yearMonth || new Date().toISOString().slice(0, 7);
    const rateMap = rateMapFromList(this.getFxRates());
    const wsIds = Array.from(new Set(accounts.map((a) => a.workspaceId)));
    const allWorkspaces = this.getWorkspaces().map((w) => w.id);
    const obligations = this.listObligations(allWorkspaces);
    const expenses = this.listExpenses(allWorkspaces);

    return accounts.map((acc) => {
      const accExpenses = expenses.filter((e) => e.accountId === acc.id);
      const pendingOutflowsMinor = accExpenses
        .filter((e) => e.status === 'pending' && e.flowDirection === 'outflow')
        .reduce((sum, e) => sum + convertMinor(e.amountMinor, e.currency, acc.currency, rateMap), 0);
      const pendingInflowsMinor = accExpenses
        .filter((e) => e.status === 'pending' && e.flowDirection === 'inflow')
        .reduce((sum, e) => sum + convertMinor(e.amountMinor, e.currency, acc.currency, rateMap), 0);

      const pendingDebitMinor = acc.pendingDebitMinor != null ? acc.pendingDebitMinor : pendingOutflowsMinor;
      const pendingCreditMinor = acc.pendingCreditMinor != null ? acc.pendingCreditMinor : pendingInflowsMinor;
      const availableBalanceMinor = acc.balanceMinor;
      const bookedBalanceMinor =
        acc.bookedBalanceMinor != null
          ? acc.bookedBalanceMinor
          : availableBalanceMinor + pendingDebitMinor - pendingCreditMinor;

      // Sinking-fund reserves parked in this account
      const lockedPreserveMinor = obligations
        .filter(
          (o) =>
            o.isActive &&
            (o.preserveAccountId || o.accountId) === acc.id &&
            o.preservedMinor > 0
        )
        .reduce((sum, o) => sum + convertMinor(o.preservedMinor, o.currency, acc.currency, rateMap), 0);

      const positiveAvailable = Math.max(0, availableBalanceMinor);
      const fundedPreserveMinor = Math.min(positiveAvailable, lockedPreserveMinor);
      const unfundedPreserveShortfallMinor = Math.max(0, lockedPreserveMinor - positiveAvailable);
      const trueAvailableMinor = Math.max(0, availableBalanceMinor - lockedPreserveMinor);
      const netAvailableAfterReservesMinor = availableBalanceMinor - lockedPreserveMinor;

      // Pocket money spending in `ym` (excluding transfers, inflows, reversed, refunded)
      const pocketMoneySpentMinor = accExpenses
        .filter(
          (e) =>
            e.spentDate.slice(0, 7) === ym &&
            e.flowDirection === 'outflow' &&
            e.kind !== 'transfer' &&
            e.status !== 'reversed' &&
            e.status !== 'refunded'
        )
        .reduce((sum, e) => sum + convertMinor(e.amountMinor, e.currency, acc.currency, rateMap), 0);

      const pocketMoneyAllowanceRemainingMinor = Math.max(0, (acc.pocketMoneyTargetMinor ?? 0) - pocketMoneySpentMinor);
      const spendablePocketMoneyMinor = Math.min(pocketMoneyAllowanceRemainingMinor, trueAvailableMinor);

      return {
        ...acc,
        availableBalanceMinor,
        bookedBalanceMinor,
        pendingDebitMinor,
        pendingCreditMinor,
        ledgerPendingDebitMinor: pendingOutflowsMinor,
        ledgerPendingCreditMinor: pendingInflowsMinor,
        lockedPreserveMinor,
        fundedPreserveMinor,
        unfundedPreserveShortfallMinor,
        trueAvailableMinor,
        netAvailableAfterReservesMinor,
        pocketMoneySpentMinor,
        pocketMoneyAllowanceRemainingMinor,
        spendablePocketMoneyMinor,
      };
    });
  }

  // ===========================================================================
  // 2. Queryable Transaction Ledger
  // ===========================================================================

  public listTransactions(params: {
    workspaceIds: string[];
    accountId?: string;
    potId?: string;
    fromDate?: string;
    toDate?: string;
    yearMonth?: string;
    status?: TransactionStatus | TransactionStatus[];
    kind?: TransactionKind | TransactionKind[];
    flowDirection?: 'outflow' | 'inflow';
    merchantQuery?: string;
    amountMinor?: number;
    transferId?: string;
    limit?: number;
    offset?: number;
  }): {
    items: ExpenseEntryRecord[];
    totalCount: number;
    hasMore: boolean;
    nextOffset: number | null;
  } {
    if (!params.workspaceIds.length) {
      return { items: [], totalCount: 0, hasMore: false, nextOffset: null };
    }
    const placeholders = params.workspaceIds.map(() => '?').join(',');
    let whereSql = ` WHERE workspace_id IN (${placeholders})`;
    const args: Array<string | number> = [...params.workspaceIds];

    if (params.accountId) {
      whereSql += ` AND account_id = ?`;
      args.push(params.accountId);
    }
    if (params.potId === 'uncategorized') {
      whereSql += ` AND pot_id IS NULL`;
    } else if (params.potId) {
      whereSql += ` AND pot_id = ?`;
      args.push(params.potId);
    }
    if (params.yearMonth) {
      whereSql += ` AND substr(spent_date, 1, 7) = ?`;
      args.push(params.yearMonth);
    }
    if (params.fromDate) {
      whereSql += ` AND substr(spent_date, 1, 10) >= ?`;
      args.push(params.fromDate.slice(0, 10));
    }
    if (params.toDate) {
      whereSql += ` AND substr(spent_date, 1, 10) <= ?`;
      args.push(params.toDate.slice(0, 10));
    }
    if (params.status) {
      const statuses = Array.isArray(params.status) ? params.status : [params.status];
      if (statuses.length > 0) {
        whereSql += ` AND COALESCE(status, 'posted') IN (${statuses.map(() => '?').join(',')})`;
        args.push(...statuses);
      }
    }
    if (params.kind) {
      const kinds = Array.isArray(params.kind) ? params.kind : [params.kind];
      if (kinds.length > 0) {
        whereSql += ` AND COALESCE(kind, CASE WHEN flow_direction = 'inflow' THEN 'deposit' ELSE 'expense' END) IN (${kinds.map(() => '?').join(',')})`;
        args.push(...kinds);
      }
    }
    if (params.flowDirection) {
      whereSql += ` AND flow_direction = ?`;
      args.push(params.flowDirection);
    }
    if (params.amountMinor !== undefined) {
      whereSql += ` AND amount_minor = ?`;
      args.push(Math.round(params.amountMinor));
    }
    if (params.transferId) {
      whereSql += ` AND transfer_id = ?`;
      args.push(params.transferId);
    }
    if (params.merchantQuery && params.merchantQuery.trim()) {
      const q = `%${params.merchantQuery.trim().toLowerCase()}%`;
      whereSql += ` AND (LOWER(merchant) LIKE ? OR LOWER(description) LIKE ? OR LOWER(COALESCE(reference, '')) LIKE ?)`;
      args.push(q, q, q);
    }

    const countRow = this.db.prepare(`SELECT COUNT(*) AS cnt FROM expenses ${whereSql}`).get(...args) as { cnt: number };
    const totalCount = Number(countRow?.cnt ?? 0);

    const limit = Math.min(500, Math.max(1, params.limit ?? 100));
    const offset = Math.max(0, params.offset ?? 0);
    const rows = this.db
      .prepare(
        `SELECT * FROM expenses ${whereSql}
         ORDER BY COALESCE(bank_timestamp, spent_date) DESC, created_at DESC, id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...args, limit, offset) as Array<Record<string, unknown>>;

    const items = rows.map((r) => this.mapExpenseRow(r));
    const hasMore = offset + items.length < totalCount;
    return {
      items,
      totalCount,
      hasMore,
      nextOffset: hasMore ? offset + items.length : null,
    };
  }

  // ===========================================================================
  // 3. Transaction Upsert, Status Promotion & Balance Delta State Machine
  // ===========================================================================

  private applyAccountBalanceDelta(accountId: string | null, availableDeltaMinor: number, bookedDeltaMinor: number): void {
    if (!accountId) return;
    if (availableDeltaMinor === 0 && bookedDeltaMinor === 0) return;
    const nowIso = new Date().toISOString();
    if (availableDeltaMinor !== 0) {
      this.db
        .prepare(`UPDATE accounts SET balance_minor = balance_minor + ?, version = COALESCE(version, 1) + 1, updated_at = ? WHERE id = ?`)
        .run(Math.round(availableDeltaMinor), nowIso, accountId);
    }
    if (bookedDeltaMinor !== 0) {
      this.db
        .prepare(
          `UPDATE accounts
           SET booked_balance_minor = CASE WHEN booked_balance_minor IS NOT NULL THEN booked_balance_minor + ? ELSE NULL END,
               updated_at = ?
           WHERE id = ?`
        )
        .run(Math.round(bookedDeltaMinor), nowIso, accountId);
    }
  }

  public findExistingTransaction(params: {
    id?: string;
    idempotencyKey?: string | null;
    providerTxId?: string | null;
  }): ExpenseEntryRecord | null {
    if (params.id) {
      const byId = this.getExpenseById(params.id);
      if (byId) return byId;
    }
    if (params.idempotencyKey) {
      const row = this.db
        .prepare(`SELECT * FROM expenses WHERE idempotency_key = ? LIMIT 1`)
        .get(params.idempotencyKey) as Record<string, unknown> | undefined;
      if (row) return this.mapExpenseRow(row);
    }
    if (params.providerTxId) {
      const row = this.db
        .prepare(`SELECT * FROM expenses WHERE provider_tx_id = ? LIMIT 1`)
        .get(params.providerTxId) as Record<string, unknown> | undefined;
      if (row) return this.mapExpenseRow(row);
    }
    return null;
  }

  private resolveValidPotId(potId: string | null | undefined, workspaceId?: string): string | null {
    if (!potId) return null;
    const exact = this.db.prepare(`SELECT id FROM pots WHERE id = ? LIMIT 1`).get(potId) as
      | { id: string }
      | undefined;
    if (exact) return exact.id;

    const normalized = potId.toLowerCase().replace(/^pot-/, '').trim();
    const allPots = workspaceId
      ? (this.db.prepare(`SELECT id, name FROM pots WHERE workspace_id = ?`).all(workspaceId) as Array<{
          id: string;
          name: string;
        }>)
      : (this.db.prepare(`SELECT id, name FROM pots`).all() as Array<{ id: string; name: string }>);

    const byName = allPots.find(
      (p) =>
        p.name.toLowerCase() === normalized ||
        p.name.toLowerCase().includes(normalized) ||
        p.id.toLowerCase().includes(normalized)
    );
    if (byName) return byName.id;

    if (normalized === 'car' || normalized === 'auto' || normalized === 'parking') {
      const veh = allPots.find((p) => p.id === 'pot-vehicles' || p.name.toLowerCase().includes('vehicle'));
      if (veh) return veh.id;
    }
    return null;
  }

  public upsertTransaction(params: {
    id?: string;
    workspaceId?: string;
    potId?: string | null;
    accountId?: string | null;
    liabilityId?: string | null;
    flowDirection?: 'outflow' | 'inflow';
    kind?: TransactionKind;
    status?: TransactionStatus;
    merchant?: string;
    description?: string;
    amountMinor?: number;
    currency?: CurrencyCode;
    originalAmountMinor?: number | null;
    originalCurrency?: CurrencyCode | null;
    fxRate?: number | null;
    feeMinor?: number | null;
    spentDate?: string;
    bankTimestamp?: string | null;
    dateOnly?: boolean;
    observedAt?: string | null;
    reference?: string | null;
    evidence?: string | null;
    providerTxId?: string | null;
    idempotencyKey?: string | null;
    transferId?: string | null;
    transferPeerId?: string | null;
    transferPeerAccountId?: string | null;
    tags?: string[];
    portalUrl?: string | null;
    source?: ExpenseEntryRecord['source'];
    items?: ExpenseSubItem[];
    balanceEffect?: 'auto' | 'apply' | 'none';
    alreadyReflectedInSnapshot?: boolean;
  }): {
    transaction: ExpenseEntryRecord;
    created: boolean;
    idempotentReplay: boolean;
    availableDeltaMinor: number;
    bookedDeltaMinor: number;
    accountBeforeBalanceMinor: number | null;
    accountAfterBalanceMinor: number | null;
  } {
    const existing = this.findExistingTransaction({
      id: params.id,
      idempotencyKey: params.idempotencyKey,
      providerTxId: params.providerTxId,
    });

    const nowIso = new Date().toISOString();
    const effectiveBalanceEffect =
      params.alreadyReflectedInSnapshot === true ? 'none' : (params.balanceEffect ?? 'auto');

    if (existing) {
      const nextWorkspaceId = params.workspaceId ?? existing.workspaceId;
      const nextPotId =
        params.potId !== undefined ? this.resolveValidPotId(params.potId, nextWorkspaceId) : existing.potId;
      const nextAccountId = params.accountId !== undefined ? params.accountId : existing.accountId;
      const nextLiabilityId = params.liabilityId !== undefined ? params.liabilityId : existing.liabilityId;
      const nextFlowDirection = params.flowDirection ?? existing.flowDirection ?? 'outflow';
      const nextKind: TransactionKind =
        params.kind ??
        (existing.kind === 'transfer'
          ? 'transfer'
          : nextFlowDirection === 'inflow'
            ? 'deposit'
            : 'expense');
      const nextStatus: TransactionStatus = params.status ?? existing.status ?? 'posted';
      const nextMerchant = params.merchant !== undefined ? params.merchant.trim() || existing.merchant : existing.merchant;
      const nextDescription = params.description !== undefined ? params.description : existing.description;
      const nextAmountMinor =
        params.amountMinor !== undefined ? Math.round(params.amountMinor) : existing.amountMinor;
      const nextCurrency: CurrencyCode = params.currency ?? existing.currency;
      const nextOriginalAmountMinor =
        params.originalAmountMinor !== undefined
          ? params.originalAmountMinor != null
            ? Math.round(params.originalAmountMinor)
            : null
          : (existing.originalAmountMinor ?? null);
      const nextOriginalCurrency =
        params.originalCurrency !== undefined ? params.originalCurrency : (existing.originalCurrency ?? null);
      const nextFxRate = params.fxRate !== undefined ? params.fxRate : (existing.fxRate ?? null);
      const nextFeeMinor =
        params.feeMinor !== undefined
          ? params.feeMinor != null
            ? Math.round(params.feeMinor)
            : null
          : (existing.feeMinor ?? null);

      let nextBankTimestamp =
        params.bankTimestamp !== undefined ? params.bankTimestamp : (existing.bankTimestamp ?? null);
      let nextSpentDate = params.spentDate !== undefined ? params.spentDate : existing.spentDate;
      if (params.dateOnly) {
        nextSpentDate = nextSpentDate.slice(0, 10);
        nextBankTimestamp = null;
      } else if (params.bankTimestamp) {
        nextBankTimestamp = params.bankTimestamp;
        if (params.spentDate === undefined) {
          nextSpentDate = params.bankTimestamp;
        }
      } else if (params.spentDate !== undefined) {
        if (params.spentDate.includes('T')) {
          nextBankTimestamp = params.spentDate;
        } else if (params.bankTimestamp === undefined) {
          nextBankTimestamp = null;
        }
      }

      const nextObservedAt = params.observedAt !== undefined ? params.observedAt : (existing.observedAt ?? null);
      const nextReference = params.reference !== undefined ? params.reference : (existing.reference ?? null);
      const nextEvidence = params.evidence !== undefined ? params.evidence : (existing.evidence ?? null);
      const nextProviderTxId =
        params.providerTxId !== undefined ? params.providerTxId : (existing.providerTxId ?? null);
      const nextIdempotencyKey =
        params.idempotencyKey !== undefined ? params.idempotencyKey : (existing.idempotencyKey ?? null);
      const nextTransferId = params.transferId !== undefined ? params.transferId : (existing.transferId ?? null);
      const nextTransferPeerId =
        params.transferPeerId !== undefined ? params.transferPeerId : (existing.transferPeerId ?? null);
      const nextTransferPeerAccountId =
        params.transferPeerAccountId !== undefined
          ? params.transferPeerAccountId
          : (existing.transferPeerAccountId ?? null);
      const nextTags = params.tags !== undefined ? params.tags : existing.tags;
      const nextPortalUrl = params.portalUrl !== undefined ? params.portalUrl : existing.portalUrl;
      const nextSource = params.source ?? existing.source;
      const nextItems = params.items !== undefined ? params.items : existing.items;

      // Compute balance delta between existing applied state and next state
      const oldSigned = existing.flowDirection === 'inflow' ? existing.amountMinor : -existing.amountMinor;
      const newSigned = nextFlowDirection === 'inflow' ? nextAmountMinor : -nextAmountMinor;

      const oldAvailApplied = existing.availableApplied !== false;
      const oldBookedApplied = existing.bookedApplied ?? existing.status === 'posted';

      const targetAvailApplied = nextStatus === 'pending' || nextStatus === 'posted';
      const targetBookedApplied = nextStatus === 'posted';

      const oldAvailContrib = oldAvailApplied ? oldSigned : 0;
      const oldBookedContrib = oldBookedApplied ? oldSigned : 0;

      const newAvailContrib = targetAvailApplied ? newSigned : 0;
      const newBookedContrib = targetBookedApplied ? newSigned : 0;

      const accBefore = nextAccountId ? this.getAccountById(nextAccountId)?.balanceMinor ?? null : null;
      let availableDeltaMinor = 0;
      let bookedDeltaMinor = 0;

      if (effectiveBalanceEffect !== 'none') {
        if (existing.accountId === nextAccountId) {
          availableDeltaMinor = newAvailContrib - oldAvailContrib;
          bookedDeltaMinor = newBookedContrib - oldBookedContrib;
          this.applyAccountBalanceDelta(nextAccountId ?? null, availableDeltaMinor, bookedDeltaMinor);
        } else {
          this.applyAccountBalanceDelta(existing.accountId ?? null, -oldAvailContrib, -oldBookedContrib);
          this.applyAccountBalanceDelta(nextAccountId ?? null, newAvailContrib, newBookedContrib);
          availableDeltaMinor = newAvailContrib;
          bookedDeltaMinor = newBookedContrib;
        }

        // Also adjust linked liability if changed
        const oldLiabSigned = existing.flowDirection === 'inflow' ? existing.amountMinor : -existing.amountMinor;
        const newLiabSigned = nextFlowDirection === 'inflow' ? nextAmountMinor : -nextAmountMinor;
        const oldLiabContrib = oldAvailApplied && existing.liabilityId ? oldLiabSigned : 0;
        const newLiabContrib = targetAvailApplied && nextLiabilityId ? newLiabSigned : 0;
        if (existing.liabilityId === nextLiabilityId && nextLiabilityId) {
          const liabDelta = newLiabContrib - oldLiabContrib;
          if (liabDelta !== 0) {
            this.db
              .prepare(`UPDATE liabilities SET balance_minor = MAX(0, balance_minor + ?), updated_at = ? WHERE id = ?`)
              .run(liabDelta, nowIso, nextLiabilityId);
          }
        } else {
          if (existing.liabilityId && oldLiabContrib !== 0) {
            this.db
              .prepare(`UPDATE liabilities SET balance_minor = MAX(0, balance_minor - ?), updated_at = ? WHERE id = ?`)
              .run(oldLiabContrib, nowIso, existing.liabilityId);
          }
          if (nextLiabilityId && newLiabContrib !== 0) {
            this.db
              .prepare(`UPDATE liabilities SET balance_minor = MAX(0, balance_minor + ?), updated_at = ? WHERE id = ?`)
              .run(newLiabContrib, nowIso, nextLiabilityId);
          }
        }
      }

      const isNoopReplay =
        availableDeltaMinor === 0 &&
        bookedDeltaMinor === 0 &&
        existing.spentDate === nextSpentDate &&
        existing.bankTimestamp === nextBankTimestamp &&
        existing.amountMinor === nextAmountMinor &&
        existing.status === nextStatus &&
        existing.potId === nextPotId &&
        existing.accountId === nextAccountId &&
        existing.merchant === nextMerchant &&
        existing.description === nextDescription;

      this.db
        .prepare(
          `UPDATE expenses
           SET workspace_id = ?,
               pot_id = ?,
               account_id = ?,
               liability_id = ?,
               flow_direction = ?,
               kind = ?,
               status = ?,
               merchant = ?,
               description = ?,
               amount_minor = ?,
               currency = ?,
               original_amount_minor = ?,
               original_currency = ?,
               fx_rate = ?,
               fee_minor = ?,
               spent_date = ?,
               bank_timestamp = ?,
               observed_at = ?,
               reference = ?,
               evidence = ?,
               provider_tx_id = ?,
               idempotency_key = ?,
               transfer_id = ?,
               transfer_peer_id = ?,
               transfer_peer_account_id = ?,
               available_applied = ?,
               booked_applied = ?,
               tags_json = ?,
               portal_url = ?,
               source = ?,
               items_json = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          nextWorkspaceId,
          nextPotId ?? null,
          nextAccountId ?? null,
          nextLiabilityId ?? null,
          nextFlowDirection,
          nextKind,
          nextStatus,
          nextMerchant,
          nextDescription,
          nextAmountMinor,
          nextCurrency,
          nextOriginalAmountMinor ?? null,
          nextOriginalCurrency ?? null,
          nextFxRate ?? null,
          nextFeeMinor ?? null,
          nextSpentDate,
          nextBankTimestamp ?? null,
          nextObservedAt ?? null,
          nextReference ?? null,
          nextEvidence ?? null,
          nextProviderTxId ?? null,
          nextIdempotencyKey ?? null,
          nextTransferId ?? null,
          nextTransferPeerId ?? null,
          nextTransferPeerAccountId ?? null,
          targetAvailApplied ? 1 : 0,
          targetBookedApplied ? 1 : 0,
          JSON.stringify(nextTags),
          nextPortalUrl ?? null,
          nextSource,
          JSON.stringify(nextItems),
          nowIso,
          existing.id
        );

      const updated = this.getExpenseById(existing.id)!;
      const accAfter = nextAccountId ? this.getAccountById(nextAccountId)?.balanceMinor ?? null : null;
      return {
        transaction: updated,
        created: false,
        idempotentReplay: isNoopReplay,
        availableDeltaMinor,
        bookedDeltaMinor,
        accountBeforeBalanceMinor: accBefore,
        accountAfterBalanceMinor: accAfter,
      };
    }

    // Creating a new transaction
    const id = params.id || `exp-${crypto.randomUUID().slice(0, 8)}`;
    const accountRec = params.accountId ? this.getAccountById(params.accountId) : null;
    const workspaceId = params.workspaceId || accountRec?.workspaceId || 'ws-home';
    const potId = this.resolveValidPotId(params.potId, workspaceId);
    const accountId = params.accountId ?? null;
    const liabilityId = params.liabilityId ?? null;
    const flowDirection = params.flowDirection === 'inflow' ? 'inflow' : 'outflow';
    const kind: TransactionKind =
      params.kind ?? (flowDirection === 'inflow' ? 'deposit' : 'expense');
    const status: TransactionStatus = params.status ?? 'posted';
    const merchant = (params.merchant || (kind === 'transfer' ? 'Internal Transfer' : 'Expense')).trim();
    const description = params.description ?? '';
    const amountMinor = Math.round(params.amountMinor ?? 0);
    const currency: CurrencyCode = params.currency || accountRec?.currency || 'GBP';
    const originalAmountMinor =
      params.originalAmountMinor != null ? Math.round(params.originalAmountMinor) : null;
    const originalCurrency = params.originalCurrency ?? null;
    const fxRate = params.fxRate ?? null;
    const feeMinor = params.feeMinor != null ? Math.round(params.feeMinor) : null;

    let bankTimestamp = params.bankTimestamp ?? null;
    let spentDate = params.spentDate || bankTimestamp || nowIso.slice(0, 10);
    if (params.dateOnly) {
      spentDate = spentDate.slice(0, 10);
      bankTimestamp = null;
    } else if (bankTimestamp && !params.spentDate) {
      spentDate = bankTimestamp;
    } else if (spentDate.includes('T') && !bankTimestamp) {
      bankTimestamp = spentDate;
    }

    const observedAt = params.observedAt ?? nowIso;
    const reference = params.reference ?? null;
    const evidence = params.evidence ?? null;
    const providerTxId = params.providerTxId ?? null;
    const idempotencyKey = params.idempotencyKey ?? null;
    const transferId = params.transferId ?? null;
    const transferPeerId = params.transferPeerId ?? null;
    const transferPeerAccountId = params.transferPeerAccountId ?? null;
    const tags = params.tags ?? [];
    const portalUrl = params.portalUrl ?? null;
    const source = params.source ?? 'manual';
    const items = params.items ?? [];

    const targetAvailApplied = status === 'pending' || status === 'posted';
    const targetBookedApplied = status === 'posted';
    const signed = flowDirection === 'inflow' ? amountMinor : -amountMinor;

    const accBefore = accountId ? this.getAccountById(accountId)?.balanceMinor ?? null : null;
    let availableDeltaMinor = 0;
    let bookedDeltaMinor = 0;

    if (effectiveBalanceEffect !== 'none') {
      availableDeltaMinor = targetAvailApplied ? signed : 0;
      bookedDeltaMinor = targetBookedApplied ? signed : 0;
      this.applyAccountBalanceDelta(accountId, availableDeltaMinor, bookedDeltaMinor);
      if (liabilityId && targetAvailApplied) {
        this.db
          .prepare(`UPDATE liabilities SET balance_minor = MAX(0, balance_minor + ?), updated_at = ? WHERE id = ?`)
          .run(signed, nowIso, liabilityId);
      }
    }

    this.db
      .prepare(
        `INSERT INTO expenses (
           id, workspace_id, pot_id, account_id, liability_id, flow_direction,
           kind, status, merchant, description, amount_minor, currency,
           original_amount_minor, original_currency, fx_rate, fee_minor,
           spent_date, bank_timestamp, observed_at, reference, evidence,
           provider_tx_id, idempotency_key, transfer_id, transfer_peer_id, transfer_peer_account_id,
           available_applied, booked_applied, tags_json, portal_url, source, items_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        workspaceId,
        potId,
        accountId,
        liabilityId,
        flowDirection,
        kind,
        status,
        merchant,
        description,
        amountMinor,
        currency,
        originalAmountMinor,
        originalCurrency,
        fxRate,
        feeMinor,
        spentDate,
        bankTimestamp,
        observedAt,
        reference,
        evidence,
        providerTxId,
        idempotencyKey,
        transferId,
        transferPeerId,
        transferPeerAccountId,
        targetAvailApplied ? 1 : 0,
        targetBookedApplied ? 1 : 0,
        JSON.stringify(tags),
        portalUrl,
        source,
        JSON.stringify(items),
        nowIso,
        nowIso
      );

    const createdTx = this.getExpenseById(id)!;
    const accAfter = accountId ? this.getAccountById(accountId)?.balanceMinor ?? null : null;
    return {
      transaction: createdTx,
      created: true,
      idempotentReplay: false,
      availableDeltaMinor,
      bookedDeltaMinor,
      accountBeforeBalanceMinor: accBefore,
      accountAfterBalanceMinor: accAfter,
    };
  }

  public deleteTransaction(
    id: string,
    options?: { balanceEffect?: 'auto' | 'none'; skipTransferPeer?: boolean }
  ): { deleted: boolean; reversedTransaction: ExpenseEntryRecord | null } {
    const existing = this.getExpenseById(id);
    if (!existing) {
      return { deleted: false, reversedTransaction: null };
    }
    if (existing.transferId && !options?.skipTransferPeer) {
      this.deleteTransfer(existing.transferId, { balanceEffect: options?.balanceEffect });
      return { deleted: true, reversedTransaction: existing };
    }

    const balanceEffect = options?.balanceEffect ?? 'auto';
    if (balanceEffect !== 'none') {
      const signed = existing.flowDirection === 'inflow' ? existing.amountMinor : -existing.amountMinor;
      const availRevert = existing.availableApplied !== false ? -signed : 0;
      const bookedRevert = (existing.bookedApplied ?? existing.status === 'posted') ? -signed : 0;
      this.applyAccountBalanceDelta(existing.accountId ?? null, availRevert, bookedRevert);
      if (existing.liabilityId && existing.availableApplied !== false) {
        this.db
          .prepare(`UPDATE liabilities SET balance_minor = MAX(0, balance_minor - ?), updated_at = ? WHERE id = ?`)
          .run(signed, new Date().toISOString(), existing.liabilityId);
      }
    }

    this.db.prepare(`DELETE FROM expenses WHERE id = ?`).run(id);
    return { deleted: true, reversedTransaction: existing };
  }

  // ===========================================================================
  // 4. Atomic Internal Transfers (Single & Multi-Account Salary Distribution)
  // ===========================================================================

  public mapTransferRow(r: Record<string, unknown>): AccountTransferRecord {
    return {
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      fromAccountId: String(r.from_account_id),
      toAccountId: String(r.to_account_id),
      fromAmountMinor: Number(r.from_amount_minor),
      fromCurrency: r.from_currency as CurrencyCode,
      toAmountMinor: Number(r.to_amount_minor),
      toCurrency: r.to_currency as CurrencyCode,
      fxRate: r.fx_rate != null ? Number(r.fx_rate) : null,
      feeMinor: Number(r.fee_minor ?? 0),
      transferDate: String(r.transfer_date),
      bankTimestamp: (r.bank_timestamp as string | null) ?? null,
      status: (r.status as TransactionStatus) || 'posted',
      description: String(r.description ?? ''),
      reference: (r.reference as string | null) ?? null,
      evidence: (r.evidence as string | null) ?? null,
      idempotencyKey: (r.idempotency_key as string | null) ?? null,
      outflowTxId: String(r.outflow_tx_id),
      inflowTxId: String(r.inflow_tx_id),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  public getTransferById(id: string): AccountTransferRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM account_transfers WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapTransferRow(row) : null;
  }

  public listTransfers(
    workspaceIds: string[],
    filters?: { accountId?: string; fromDate?: string; toDate?: string; yearMonth?: string }
  ): AccountTransferRecord[] {
    if (!workspaceIds.length) return [];
    const placeholders = workspaceIds.map(() => '?').join(',');
    let sql = `
      SELECT DISTINCT t.*
      FROM account_transfers t
      LEFT JOIN accounts fa ON fa.id = t.from_account_id
      LEFT JOIN accounts ta ON ta.id = t.to_account_id
      WHERE (t.workspace_id IN (${placeholders}) OR fa.workspace_id IN (${placeholders}) OR ta.workspace_id IN (${placeholders}))
    `;
    const args: Array<string | number> = [...workspaceIds, ...workspaceIds, ...workspaceIds];
    if (filters?.accountId) {
      sql += ` AND (t.from_account_id = ? OR t.to_account_id = ?)`;
      args.push(filters.accountId, filters.accountId);
    }
    if (filters?.yearMonth) {
      sql += ` AND substr(t.transfer_date, 1, 7) = ?`;
      args.push(filters.yearMonth);
    }
    if (filters?.fromDate) {
      sql += ` AND substr(t.transfer_date, 1, 10) >= ?`;
      args.push(filters.fromDate.slice(0, 10));
    }
    if (filters?.toDate) {
      sql += ` AND substr(t.transfer_date, 1, 10) <= ?`;
      args.push(filters.toDate.slice(0, 10));
    }
    sql += ` ORDER BY COALESCE(t.bank_timestamp, t.transfer_date) DESC, t.created_at DESC`;
    const rows = this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapTransferRow(r));
  }

  public createTransfer(params: {
    id?: string;
    fromAccountId: string;
    toAccountId: string;
    amountMinor?: number;
    fromAmountMinor?: number;
    toAmountMinor?: number;
    feeMinor?: number;
    fxRate?: number | null;
    transferDate?: string;
    bankTimestamp?: string | null;
    status?: TransactionStatus;
    description?: string;
    reference?: string | null;
    evidence?: string | null;
    idempotencyKey?: string | null;
    balanceEffect?: 'auto' | 'apply' | 'none' | { from?: 'apply' | 'none'; to?: 'apply' | 'none' };
    reconcileExistingOutflowTxId?: string | null;
    reconcileExistingInflowTxId?: string | null;
  }): {
    transfer: AccountTransferRecord;
    outflowLeg: ExpenseEntryRecord;
    inflowLeg: ExpenseEntryRecord;
    fromAccountBeforeMinor: number;
    fromAccountAfterMinor: number;
    toAccountBeforeMinor: number;
    toAccountAfterMinor: number;
    idempotentReplay: boolean;
  } {
    if (params.fromAccountId === params.toAccountId) {
      throw new Error('Source and destination accounts must be different');
    }

    if (params.idempotencyKey) {
      const existingRow = this.db
        .prepare(`SELECT * FROM account_transfers WHERE idempotency_key = ? LIMIT 1`)
        .get(params.idempotencyKey) as Record<string, unknown> | undefined;
      if (existingRow) {
        const existingTransfer = this.mapTransferRow(existingRow);
        const outLeg = this.getExpenseById(existingTransfer.outflowTxId)!;
        const inLeg = this.getExpenseById(existingTransfer.inflowTxId)!;
        const fromAcc = this.getAccountById(existingTransfer.fromAccountId)!;
        const toAcc = this.getAccountById(existingTransfer.toAccountId)!;
        return {
          transfer: existingTransfer,
          outflowLeg: outLeg,
          inflowLeg: inLeg,
          fromAccountBeforeMinor: fromAcc.balanceMinor,
          fromAccountAfterMinor: fromAcc.balanceMinor,
          toAccountBeforeMinor: toAcc.balanceMinor,
          toAccountAfterMinor: toAcc.balanceMinor,
          idempotentReplay: true,
        };
      }
    }

    const fromAcc = this.getAccountById(params.fromAccountId);
    const toAcc = this.getAccountById(params.toAccountId);
    if (!fromAcc) throw new Error(`Source account "${params.fromAccountId}" not found`);
    if (!toAcc) throw new Error(`Destination account "${params.toAccountId}" not found`);

    const fromAmountMinor = Math.round(params.fromAmountMinor ?? params.amountMinor ?? 0);
    if (fromAmountMinor <= 0) {
      throw new Error('Transfer amount must be greater than zero');
    }
    const feeMinor = Math.max(0, Math.round(params.feeMinor ?? 0));
    const rateMap = rateMapFromList(this.getFxRates());
    const computedToMinor =
      params.toAmountMinor !== undefined
        ? Math.round(params.toAmountMinor)
        : fromAcc.currency === toAcc.currency
          ? fromAmountMinor
          : params.fxRate && params.fxRate > 0
            ? Math.round(fromAmountMinor * params.fxRate)
            : convertMinor(fromAmountMinor, fromAcc.currency, toAcc.currency, rateMap);

    const nowIso = new Date().toISOString();
    const bankTimestamp = params.bankTimestamp ?? null;
    const transferDate = params.transferDate || bankTimestamp || nowIso.slice(0, 10);
    const status: TransactionStatus = params.status ?? 'posted';
    const description = params.description?.trim() ?? '';
    const reference = params.reference ?? null;
    const evidence = params.evidence ?? null;

    const transferId = params.id || `trf-${crypto.randomUUID().slice(0, 8)}`;
    const outflowTxId = params.reconcileExistingOutflowTxId || `exp-${crypto.randomUUID().slice(0, 8)}`;
    const inflowTxId = params.reconcileExistingInflowTxId || `exp-${crypto.randomUUID().slice(0, 8)}`;

    const fromEffect: 'auto' | 'apply' | 'none' =
      typeof params.balanceEffect === 'object' && params.balanceEffect !== null
        ? (params.balanceEffect.from ?? 'auto')
        : (params.balanceEffect ?? 'auto');
    const toEffect: 'auto' | 'apply' | 'none' =
      typeof params.balanceEffect === 'object' && params.balanceEffect !== null
        ? (params.balanceEffect.to ?? 'auto')
        : (params.balanceEffect ?? 'auto');

    const fromBefore = fromAcc.balanceMinor;
    const toBefore = toAcc.balanceMinor;

    const outRes = this.upsertTransaction({
      id: outflowTxId,
      workspaceId: fromAcc.workspaceId,
      potId: null,
      accountId: fromAcc.id,
      flowDirection: 'outflow',
      kind: 'transfer',
      status,
      merchant: `Transfer to ${toAcc.name}`,
      description,
      amountMinor: fromAmountMinor + feeMinor,
      currency: fromAcc.currency,
      originalAmountMinor: fromAmountMinor,
      originalCurrency: fromAcc.currency,
      fxRate: params.fxRate ?? null,
      feeMinor: feeMinor > 0 ? feeMinor : null,
      spentDate: transferDate,
      bankTimestamp,
      reference,
      evidence,
      idempotencyKey: params.idempotencyKey ? `${params.idempotencyKey}:out` : null,
      transferId,
      transferPeerId: inflowTxId,
      transferPeerAccountId: toAcc.id,
      tags: ['transfer'],
      balanceEffect: fromEffect,
    });

    const inRes = this.upsertTransaction({
      id: inflowTxId,
      workspaceId: toAcc.workspaceId,
      potId: null,
      accountId: toAcc.id,
      flowDirection: 'inflow',
      kind: 'transfer',
      status,
      merchant: `Transfer from ${fromAcc.name}`,
      description,
      amountMinor: computedToMinor,
      currency: toAcc.currency,
      originalAmountMinor: fromAmountMinor,
      originalCurrency: fromAcc.currency,
      fxRate: params.fxRate ?? null,
      feeMinor: null,
      spentDate: transferDate,
      bankTimestamp,
      reference,
      evidence,
      idempotencyKey: params.idempotencyKey ? `${params.idempotencyKey}:in` : null,
      transferId,
      transferPeerId: outflowTxId,
      transferPeerAccountId: fromAcc.id,
      tags: ['transfer'],
      balanceEffect: toEffect,
    });

    this.db
      .prepare(
        `INSERT INTO account_transfers (
           id, workspace_id, from_account_id, to_account_id,
           from_amount_minor, from_currency, to_amount_minor, to_currency,
           fx_rate, fee_minor, transfer_date, bank_timestamp, status,
           description, reference, evidence, idempotency_key,
           outflow_tx_id, inflow_tx_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           from_account_id = excluded.from_account_id,
           to_account_id = excluded.to_account_id,
           from_amount_minor = excluded.from_amount_minor,
           from_currency = excluded.from_currency,
           to_amount_minor = excluded.to_amount_minor,
           to_currency = excluded.to_currency,
           fx_rate = excluded.fx_rate,
           fee_minor = excluded.fee_minor,
           transfer_date = excluded.transfer_date,
           bank_timestamp = excluded.bank_timestamp,
           status = excluded.status,
           description = excluded.description,
           reference = excluded.reference,
           evidence = excluded.evidence,
           outflow_tx_id = excluded.outflow_tx_id,
           inflow_tx_id = excluded.inflow_tx_id,
           updated_at = excluded.updated_at`
      )
      .run(
        transferId,
        fromAcc.workspaceId,
        fromAcc.id,
        toAcc.id,
        fromAmountMinor,
        fromAcc.currency,
        computedToMinor,
        toAcc.currency,
        params.fxRate ?? null,
        feeMinor,
        transferDate,
        bankTimestamp,
        status,
        description,
        reference,
        evidence,
        params.idempotencyKey ?? null,
        outRes.transaction.id,
        inRes.transaction.id,
        nowIso,
        nowIso
      );

    const fromAfter = this.getAccountById(fromAcc.id)!.balanceMinor;
    const toAfter = this.getAccountById(toAcc.id)!.balanceMinor;

    return {
      transfer: this.getTransferById(transferId)!,
      outflowLeg: outRes.transaction,
      inflowLeg: inRes.transaction,
      fromAccountBeforeMinor: fromBefore,
      fromAccountAfterMinor: fromAfter,
      toAccountBeforeMinor: toBefore,
      toAccountAfterMinor: toAfter,
      idempotentReplay: false,
    };
  }

  public createTransferBatch(params: {
    fromAccountId: string;
    transferDate?: string;
    bankTimestamp?: string | null;
    status?: TransactionStatus;
    description?: string;
    reference?: string | null;
    idempotencyKey?: string | null;
    legs: Array<{
      toAccountId: string;
      amountMinor: number;
      toAmountMinor?: number;
      feeMinor?: number;
      fxRate?: number | null;
      description?: string;
      reference?: string | null;
    }>;
  }) {
    if (!Array.isArray(params.legs) || params.legs.length === 0) {
      throw new Error('At least one destination transfer leg is required');
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const fromBefore = this.getAccountById(params.fromAccountId)?.balanceMinor ?? 0;
      const results = params.legs.map((leg, idx) =>
        this.createTransfer({
          fromAccountId: params.fromAccountId,
          toAccountId: leg.toAccountId,
          fromAmountMinor: leg.amountMinor,
          toAmountMinor: leg.toAmountMinor,
          feeMinor: leg.feeMinor,
          fxRate: leg.fxRate,
          transferDate: params.transferDate,
          bankTimestamp: params.bankTimestamp,
          status: params.status,
          description: leg.description ?? params.description,
          reference: leg.reference ?? params.reference,
          idempotencyKey: params.idempotencyKey ? `${params.idempotencyKey}:leg-${idx}` : null,
        })
      );
      const fromAfter = this.getAccountById(params.fromAccountId)?.balanceMinor ?? 0;
      this.db.exec('COMMIT;');
      return {
        fromAccountId: params.fromAccountId,
        fromAccountBeforeMinor: fromBefore,
        fromAccountAfterMinor: fromAfter,
        totalDeductedMinor: fromBefore - fromAfter,
        transfers: results,
      };
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  public updateTransfer(
    transferId: string,
    patch: {
      fromAccountId?: string;
      toAccountId?: string;
      amountMinor?: number;
      fromAmountMinor?: number;
      toAmountMinor?: number;
      feeMinor?: number;
      fxRate?: number | null;
      transferDate?: string;
      bankTimestamp?: string | null;
      status?: TransactionStatus;
      description?: string;
      reference?: string | null;
      evidence?: string | null;
      balanceEffect?: 'auto' | 'apply' | 'none';
    }
  ): {
    transfer: AccountTransferRecord;
    outflowLeg: ExpenseEntryRecord;
    inflowLeg: ExpenseEntryRecord;
  } {
    const existing = this.getTransferById(transferId);
    if (!existing) {
      throw new Error(`Transfer "${transferId}" not found`);
    }

    const nextFromAccId = patch.fromAccountId ?? existing.fromAccountId;
    const nextToAccId = patch.toAccountId ?? existing.toAccountId;
    if (nextFromAccId === nextToAccId) {
      throw new Error('Source and destination accounts must be different');
    }
    const fromAcc = this.getAccountById(nextFromAccId);
    const toAcc = this.getAccountById(nextToAccId);
    if (!fromAcc || !toAcc) {
      throw new Error('Source or destination account not found');
    }

    const nextFromMinor = Math.round(patch.fromAmountMinor ?? patch.amountMinor ?? existing.fromAmountMinor);
    const nextFeeMinor = Math.max(0, Math.round(patch.feeMinor ?? existing.feeMinor));
    const nextFxRate = patch.fxRate !== undefined ? patch.fxRate : existing.fxRate;
    const rateMap = rateMapFromList(this.getFxRates());
    const nextToMinor =
      patch.toAmountMinor !== undefined
        ? Math.round(patch.toAmountMinor)
        : fromAcc.currency === toAcc.currency
          ? nextFromMinor
          : nextFxRate && nextFxRate > 0
            ? Math.round(nextFromMinor * nextFxRate)
            : convertMinor(nextFromMinor, fromAcc.currency, toAcc.currency, rateMap);

    const nextTransferDate = patch.transferDate ?? existing.transferDate;
    const nextBankTimestamp = patch.bankTimestamp !== undefined ? patch.bankTimestamp : existing.bankTimestamp;
    const nextStatus = patch.status ?? existing.status;
    const nextDescription = patch.description ?? existing.description;
    const nextReference = patch.reference !== undefined ? patch.reference : existing.reference;
    const nextEvidence = patch.evidence !== undefined ? patch.evidence : existing.evidence;
    const nowIso = new Date().toISOString();

    const outRes = this.upsertTransaction({
      id: existing.outflowTxId,
      workspaceId: fromAcc.workspaceId,
      accountId: fromAcc.id,
      flowDirection: 'outflow',
      kind: 'transfer',
      status: nextStatus,
      merchant: `Transfer to ${toAcc.name}`,
      description: nextDescription,
      amountMinor: nextFromMinor + nextFeeMinor,
      currency: fromAcc.currency,
      originalAmountMinor: nextFromMinor,
      originalCurrency: fromAcc.currency,
      fxRate: nextFxRate,
      feeMinor: nextFeeMinor > 0 ? nextFeeMinor : null,
      spentDate: nextTransferDate,
      bankTimestamp: nextBankTimestamp,
      reference: nextReference,
      evidence: nextEvidence,
      transferId: existing.id,
      transferPeerId: existing.inflowTxId,
      transferPeerAccountId: toAcc.id,
      balanceEffect: patch.balanceEffect ?? 'auto',
    });

    const inRes = this.upsertTransaction({
      id: existing.inflowTxId,
      workspaceId: toAcc.workspaceId,
      accountId: toAcc.id,
      flowDirection: 'inflow',
      kind: 'transfer',
      status: nextStatus,
      merchant: `Transfer from ${fromAcc.name}`,
      description: nextDescription,
      amountMinor: nextToMinor,
      currency: toAcc.currency,
      originalAmountMinor: nextFromMinor,
      originalCurrency: fromAcc.currency,
      fxRate: nextFxRate,
      spentDate: nextTransferDate,
      bankTimestamp: nextBankTimestamp,
      reference: nextReference,
      evidence: nextEvidence,
      transferId: existing.id,
      transferPeerId: existing.outflowTxId,
      transferPeerAccountId: fromAcc.id,
      balanceEffect: patch.balanceEffect ?? 'auto',
    });

    this.db
      .prepare(
        `UPDATE account_transfers
         SET workspace_id = ?,
             from_account_id = ?,
             to_account_id = ?,
             from_amount_minor = ?,
             from_currency = ?,
             to_amount_minor = ?,
             to_currency = ?,
             fx_rate = ?,
             fee_minor = ?,
             transfer_date = ?,
             bank_timestamp = ?,
             status = ?,
             description = ?,
             reference = ?,
             evidence = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        fromAcc.workspaceId,
        fromAcc.id,
        toAcc.id,
        nextFromMinor,
        fromAcc.currency,
        nextToMinor,
        toAcc.currency,
        nextFxRate,
        nextFeeMinor,
        nextTransferDate,
        nextBankTimestamp,
        nextStatus,
        nextDescription,
        nextReference,
        nextEvidence,
        nowIso,
        existing.id
      );

    return {
      transfer: this.getTransferById(existing.id)!,
      outflowLeg: outRes.transaction,
      inflowLeg: inRes.transaction,
    };
  }

  public deleteTransfer(
    transferId: string,
    options?: { balanceEffect?: 'auto' | 'none' }
  ): { deleted: boolean; transfer: AccountTransferRecord | null } {
    const existing = this.getTransferById(transferId);
    if (!existing) {
      return { deleted: false, transfer: null };
    }
    this.deleteTransaction(existing.outflowTxId, {
      balanceEffect: options?.balanceEffect,
      skipTransferPeer: true,
    });
    this.deleteTransaction(existing.inflowTxId, {
      balanceEffect: options?.balanceEffect,
      skipTransferPeer: true,
    });
    this.db.prepare(`DELETE FROM account_transfers WHERE id = ?`).run(transferId);
    return { deleted: true, transfer: existing };
  }

  // ===========================================================================
  // 5 & 6. Obligation Payment Events & Finite / Variable Schedules
  // ===========================================================================

  public recordObligationPayment(params: {
    obligationId: string;
    yearMonth?: string;
    paid?: boolean;
    amountMinor?: number;
    bankDate?: string | null;
    accountId?: string | null;
    linkedTransactionId?: string | null;
    evidence?: string | null;
    notes?: string | null;
    idempotencyKey?: string | null;
    balanceEffect?: 'auto' | 'apply' | 'none';
  }): {
    occurrence: PaymentOccurrenceRecord | null;
    obligation: ObligationRecord;
    accountBeforeBalanceMinor: number | null;
    accountAfterBalanceMinor: number | null;
    idempotentReplay: boolean;
  } {
    const ob = this.getObligationById(params.obligationId);
    if (!ob) {
      throw new Error(`Obligation "${params.obligationId}" not found`);
    }

    const ym = params.yearMonth || ob.nextDueDate.slice(0, 7);
    const isPaid = params.paid !== false;
    const nowIso = new Date().toISOString();

    const existingRow = this.db
      .prepare(`SELECT * FROM payment_occurrences WHERE obligation_id = ? AND year_month = ?`)
      .get(ob.id, ym) as Record<string, unknown> | undefined;
    const existing = existingRow ? this.mapPaymentOccurrenceRow(existingRow) : null;

    if (!isPaid) {
      // Reverse / unmark existing payment occurrence
      const targetAccId = existing?.accountId ?? ob.accountId;
      const accBefore = targetAccId ? this.getAccountById(targetAccId)?.balanceMinor ?? null : null;

      if (existing && existing.status === 'paid') {
        const shouldRevertBalance = (params.balanceEffect ?? 'auto') !== 'none' && existing.balanceApplied;
        const paidMinor = existing.actualPaidMinor ?? existing.expectedMinor ?? ob.amountMinor;
        if (shouldRevertBalance && targetAccId && paidMinor > 0) {
          this.applyAccountBalanceDelta(targetAccId, +paidMinor, +paidMinor);
        }
        if (existing.liabilityId && (existing.liabilityDeltaMinor ?? 0) > 0) {
          this.db
            .prepare(`UPDATE liabilities SET balance_minor = balance_minor + ?, updated_at = ? WHERE id = ?`)
            .run(existing.liabilityDeltaMinor ?? 0, nowIso, existing.liabilityId);
        }
        // Restore schedule due date if it had been advanced past this occurrence's dueDate
        const restoredDueDate = existing.dueDate || `${ym}-${String(ob.dueDay).padStart(2, '0')}`;
        const nextRemaining = ob.remainingPayments != null ? ob.remainingPayments + 1 : null;
        this.db
          .prepare(
            `UPDATE obligations
             SET next_due_date = CASE WHEN next_due_date > ? THEN ? ELSE next_due_date END,
                 is_active = 1,
                 remaining_payments = ?
             WHERE id = ?`
          )
          .run(restoredDueDate, restoredDueDate, nextRemaining, ob.id);

        this.db.prepare(`DELETE FROM payment_occurrences WHERE id = ?`).run(existing.id);
      }

      const accAfter = targetAccId ? this.getAccountById(targetAccId)?.balanceMinor ?? null : null;
      return {
        occurrence: null,
        obligation: this.getObligationById(ob.id)!,
        accountBeforeBalanceMinor: accBefore,
        accountAfterBalanceMinor: accAfter,
        idempotentReplay: !existing || existing.status !== 'paid',
      };
    }

    // Marking or updating a paid occurrence
    const targetAccountId =
      params.accountId !== undefined ? params.accountId : (existing?.accountId ?? ob.accountId ?? null);
    const targetLiabilityId = existing?.liabilityId ?? ob.liabilityId ?? null;
    const expectedMinor =
      existing && existing.expectedMinor > 0
        ? existing.expectedMinor
        : ob.endDate && ob.endDate.slice(0, 7) === ym && ob.finalAmountMinor != null && ob.finalAmountMinor > 0
          ? ob.finalAmountMinor
          : ob.amountMinor;
    const actualPaidMinor =
      params.amountMinor !== undefined
        ? Math.round(params.amountMinor)
        : existing?.actualPaidMinor != null && existing.status === 'paid'
          ? existing.actualPaidMinor
          : expectedMinor;

    // Preserve original recordedAt when updating/replaying an already-recorded occurrence
    const recordedAt = existing?.recordedAt || nowIso;
    const dueDate = existing?.dueDate || `${ym}-${String(ob.dueDay).padStart(2, '0')}`;
    const bankDate =
      params.bankDate !== undefined
        ? params.bankDate
        : (existing?.bankDate ?? existing?.paidAt?.slice(0, 10) ?? dueDate);
    const paidAt = params.bankDate
      ? params.bankDate
      : (existing?.paidAt ?? nowIso);
    const linkedTxId =
      params.linkedTransactionId !== undefined ? params.linkedTransactionId : (existing?.linkedTransactionId ?? null);
    const evidence = params.evidence !== undefined ? params.evidence : (existing?.evidence ?? null);
    const notes = params.notes !== undefined ? params.notes : (existing?.notes ?? null);
    const idempotencyKey =
      params.idempotencyKey !== undefined ? params.idempotencyKey : (existing?.idempotencyKey ?? null);

    // Check if linked transaction already debited the account
    const linkedTx = linkedTxId ? this.getExpenseById(linkedTxId) : null;
    const linkedTxAlreadyApplied = Boolean(linkedTx && linkedTx.availableApplied !== false);

    const balanceMode = params.balanceEffect ?? 'auto';
    const wantBalanceApplied =
      balanceMode === 'apply' ? true : balanceMode === 'none' ? false : !linkedTxAlreadyApplied;

    const accBefore = targetAccountId ? this.getAccountById(targetAccountId)?.balanceMinor ?? null : null;

    const oldApplied = Boolean(existing && existing.status === 'paid' && existing.balanceApplied);
    const oldPaidMinor = oldApplied ? (existing!.actualPaidMinor ?? existing!.expectedMinor) : 0;
    const oldAccId = existing?.accountId ?? null;

    if (oldApplied && !wantBalanceApplied) {
      this.applyAccountBalanceDelta(oldAccId, +oldPaidMinor, +oldPaidMinor);
    } else if (!oldApplied && wantBalanceApplied) {
      this.applyAccountBalanceDelta(targetAccountId, -actualPaidMinor, -actualPaidMinor);
    } else if (oldApplied && wantBalanceApplied) {
      if (oldAccId === targetAccountId) {
        const delta = -(actualPaidMinor - oldPaidMinor);
        this.applyAccountBalanceDelta(targetAccountId, delta, delta);
      } else {
        this.applyAccountBalanceDelta(oldAccId, +oldPaidMinor, +oldPaidMinor);
        this.applyAccountBalanceDelta(targetAccountId, -actualPaidMinor, -actualPaidMinor);
      }
    }

    // Linked mortgage/loan principal reduction (idempotent delta)
    let liabilityDeltaMinor = existing?.liabilityDeltaMinor ?? 0;
    if (targetLiabilityId && wantBalanceApplied) {
      const liabRow = this.db
        .prepare(`SELECT balance_minor, apr_bp FROM liabilities WHERE id = ?`)
        .get(targetLiabilityId) as { balance_minor: number; apr_bp: number } | undefined;
      if (liabRow && liabRow.balance_minor > 0) {
        const baseBal = liabRow.balance_minor + (existing?.liabilityDeltaMinor ?? 0);
        const monthlyInterest = Math.round((baseBal * (liabRow.apr_bp / 10000)) / 12);
        const principalReduction = Math.max(0, Math.min(baseBal, actualPaidMinor - monthlyInterest));
        const liabAdjustment = principalReduction - (existing?.liabilityDeltaMinor ?? 0);
        if (liabAdjustment !== 0) {
          this.db
            .prepare(`UPDATE liabilities SET balance_minor = MAX(0, balance_minor - ?), updated_at = ? WHERE id = ?`)
            .run(liabAdjustment, nowIso, targetLiabilityId);
        }
        liabilityDeltaMinor = principalReduction;
      }
    }

    const wasAlreadyPaid = Boolean(existing && existing.status === 'paid');
    const isIdempotentReplay =
      wasAlreadyPaid &&
      existing!.actualPaidMinor === actualPaidMinor &&
      existing!.accountId === targetAccountId &&
      existing!.bankDate === bankDate;

    const occId = existing?.id || `occ-${crypto.randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `INSERT INTO payment_occurrences (
           id, obligation_id, account_id, liability_id, liability_delta_minor,
           year_month, due_date, expected_minor, actual_paid_minor, currency,
           status, paid_at, bank_date, recorded_at, linked_transaction_id,
           evidence, idempotency_key, balance_applied, notes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(obligation_id, year_month) DO UPDATE SET
           account_id = excluded.account_id,
           liability_id = excluded.liability_id,
           liability_delta_minor = excluded.liability_delta_minor,
           actual_paid_minor = excluded.actual_paid_minor,
           status = 'paid',
           paid_at = excluded.paid_at,
           bank_date = excluded.bank_date,
           recorded_at = COALESCE(payment_occurrences.recorded_at, excluded.recorded_at),
           linked_transaction_id = excluded.linked_transaction_id,
           evidence = excluded.evidence,
           idempotency_key = excluded.idempotency_key,
           balance_applied = excluded.balance_applied,
           notes = excluded.notes`
      )
      .run(
        occId,
        ob.id,
        targetAccountId,
        targetLiabilityId,
        liabilityDeltaMinor,
        ym,
        dueDate,
        expectedMinor,
        actualPaidMinor,
        ob.currency,
        paidAt,
        bankDate,
        recordedAt,
        linkedTxId,
        evidence,
        idempotencyKey,
        wantBalanceApplied ? 1 : 0,
        notes
      );

    // Advance the obligation schedule ONLY if this period wasn't already marked paid
    if (!wasAlreadyPaid) {
      const reset = applyObligationPaymentReset(ob, ym);
      this.db
        .prepare(
          `UPDATE obligations
           SET next_due_date = ?,
               preserved_minor = ?,
               is_active = ?,
               remaining_payments = ?
           WHERE id = ?`
        )
        .run(reset.nextDueDate, reset.preservedMinor, reset.isActive ? 1 : 0, reset.remainingPayments, ob.id);
    }

    const updatedOccRow = this.db
      .prepare(`SELECT * FROM payment_occurrences WHERE obligation_id = ? AND year_month = ?`)
      .get(ob.id, ym) as Record<string, unknown>;
    const accAfter = targetAccountId ? this.getAccountById(targetAccountId)?.balanceMinor ?? null : null;

    return {
      occurrence: this.mapPaymentOccurrenceRow(updatedOccRow),
      obligation: this.getObligationById(ob.id)!,
      accountBeforeBalanceMinor: accBefore,
      accountAfterBalanceMinor: accAfter,
      idempotentReplay: isIdempotentReplay,
    };
  }

  public updateObligationSchedule(params: {
    obligationId: string;
    amountMinor?: number;
    finalAmountMinor?: number | null;
    endDate?: string | null;
    remainingPayments?: number | null;
    nextDueDate?: string;
    dueDay?: number;
    cadence?: CadenceKind;
    intervalMonths?: number;
    isActive?: boolean;
    notes?: string | null;
    futureInstances?: Array<{
      yearMonth: string;
      dueDate?: string;
      expectedMinor: number;
      status?: 'upcoming' | 'skipped';
      notes?: string | null;
    }>;
  }): {
    obligation: ObligationRecord;
    updatedInstances: PaymentOccurrenceRecord[];
  } {
    const ob = this.getObligationById(params.obligationId);
    if (!ob) {
      throw new Error(`Obligation "${params.obligationId}" not found`);
    }

    const nextAmountMinor = params.amountMinor !== undefined ? Math.round(params.amountMinor) : ob.amountMinor;
    const nextFinalAmountMinor =
      params.finalAmountMinor !== undefined
        ? params.finalAmountMinor != null
          ? Math.round(params.finalAmountMinor)
          : null
        : (ob.finalAmountMinor ?? null);
    const nextEndDate = params.endDate !== undefined ? params.endDate : (ob.endDate ?? null);
    const nextRemainingPayments =
      params.remainingPayments !== undefined ? params.remainingPayments : (ob.remainingPayments ?? null);
    const nextDueDate = params.nextDueDate ?? ob.nextDueDate;
    const nextDueDay =
      params.dueDay !== undefined
        ? Math.min(31, Math.max(1, Number(params.dueDay)))
        : params.nextDueDate
          ? Number(params.nextDueDate.split('-')[2] || ob.dueDay)
          : ob.dueDay;
    const nextCadence = params.cadence ?? ob.cadence;
    const nextIntervalMonths = params.intervalMonths !== undefined ? params.intervalMonths : ob.intervalMonths;
    const nextIsActive = params.isActive !== undefined ? params.isActive : ob.isActive;
    const nextNotes = params.notes !== undefined ? params.notes : ob.notes;

    this.db
      .prepare(
        `UPDATE obligations
         SET amount_minor = ?,
             final_amount_minor = ?,
             end_date = ?,
             remaining_payments = ?,
             next_due_date = ?,
             due_day = ?,
             cadence = ?,
             interval_months = ?,
             is_active = ?,
             notes = ?
         WHERE id = ?`
      )
      .run(
        nextAmountMinor,
        nextFinalAmountMinor,
        nextEndDate,
        nextRemainingPayments,
        nextDueDate,
        nextDueDay,
        nextCadence,
        nextIntervalMonths,
        nextIsActive ? 1 : 0,
        nextNotes,
        ob.id
      );

    // If finalAmountMinor and endDate are provided, also ensure an upcoming occurrence for endDate's month reflects finalAmountMinor (unless already paid)
    const instancesToUpsert = [...(params.futureInstances ?? [])];
    if (
      nextEndDate &&
      nextFinalAmountMinor != null &&
      nextFinalAmountMinor > 0 &&
      !instancesToUpsert.some((i) => i.yearMonth === nextEndDate.slice(0, 7))
    ) {
      instancesToUpsert.push({
        yearMonth: nextEndDate.slice(0, 7),
        dueDate: nextEndDate,
        expectedMinor: nextFinalAmountMinor,
        status: 'upcoming',
      });
    }

    const updatedInstances: PaymentOccurrenceRecord[] = [];
    for (const inst of instancesToUpsert) {
      const existingRow = this.db
        .prepare(`SELECT * FROM payment_occurrences WHERE obligation_id = ? AND year_month = ?`)
        .get(ob.id, inst.yearMonth) as Record<string, unknown> | undefined;
      if (existingRow && existingRow.status === 'paid') {
        // Never overwrite historical paid occurrences!
        updatedInstances.push(this.mapPaymentOccurrenceRow(existingRow));
        continue;
      }
      const occId = existingRow ? String(existingRow.id) : `occ-${crypto.randomUUID().slice(0, 8)}`;
      const dueDate = inst.dueDate || `${inst.yearMonth}-${String(nextDueDay).padStart(2, '0')}`;
      const status = inst.status === 'skipped' ? 'skipped' : 'upcoming';
      this.db
        .prepare(
          `INSERT INTO payment_occurrences (
             id, obligation_id, account_id, liability_id, year_month, due_date,
             expected_minor, actual_paid_minor, currency, status, notes
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
           ON CONFLICT(obligation_id, year_month) DO UPDATE SET
             due_date = excluded.due_date,
             expected_minor = excluded.expected_minor,
             status = CASE WHEN payment_occurrences.status = 'paid' THEN 'paid' ELSE excluded.status END,
             notes = COALESCE(excluded.notes, payment_occurrences.notes)`
        )
        .run(
          occId,
          ob.id,
          ob.accountId ?? null,
          ob.liabilityId ?? null,
          inst.yearMonth,
          dueDate,
          Math.round(inst.expectedMinor),
          ob.currency,
          status,
          inst.notes ?? null
        );
      const row = this.db
        .prepare(`SELECT * FROM payment_occurrences WHERE obligation_id = ? AND year_month = ?`)
        .get(ob.id, inst.yearMonth) as Record<string, unknown>;
      updatedInstances.push(this.mapPaymentOccurrenceRow(row));
    }

    return {
      obligation: this.getObligationById(ob.id)!,
      updatedInstances,
    };
  }

  // ===========================================================================
  // 8. Safe Atomic Reconciliation Batch (Dry-Run Preview, Audit & Reversal)
  // ===========================================================================

  public reconcileBatch(
    userId: string,
    input: {
      dryRun?: boolean;
      idempotencyKey?: string;
      snapshotMode?: 'apply_deltas' | 'already_reflected_in_snapshot';
      expectedAccounts?: Array<{
        accountId: string;
        expectedVersion?: number;
        expectedAvailableBalanceMinor?: number;
        expectedBookedBalanceMinor?: number;
      }>;
      accountSnapshots?: Array<{
        accountId: string;
        availableBalanceMinor?: number;
        balanceMinor?: number;
        bookedBalanceMinor?: number | null;
        pendingDebitMinor?: number | null;
        pendingCreditMinor?: number | null;
        observedAt?: string;
        source?: string;
        evidence?: string;
        reconciled?: boolean;
        notes?: string;
        timing?: 'before_ops' | 'after_ops';
      }>;
      transactions?: Array<Parameters<FinanceStore['upsertTransaction']>[0]>;
      transfers?: Array<Parameters<FinanceStore['createTransfer']>[0]>;
      obligationPayments?: Array<Parameters<FinanceStore['recordObligationPayment']>[0]>;
      obligationSchedules?: Array<Parameters<FinanceStore['updateObligationSchedule']>[0]>;
      assertAfterAccounts?: Array<{
        accountId: string;
        expectedAvailableBalanceMinor?: number;
        expectedBookedBalanceMinor?: number;
      }>;
    }
  ) {
    const dryRun = Boolean(input.dryRun);
    if (input.idempotencyKey && !dryRun) {
      const existingBatch = this.db
        .prepare(`SELECT * FROM reconciliation_batches WHERE idempotency_key = ? AND status = 'applied' LIMIT 1`)
        .get(input.idempotencyKey) as Record<string, unknown> | undefined;
      if (existingBatch) {
        const summary = JSON.parse(String(existingBatch.summary_json));
        return {
          ...summary,
          batchId: String(existingBatch.id),
          dryRun: false,
          idempotentReplay: true,
        };
      }
    }

    const batchId = `rec-${crypto.randomUUID().slice(0, 8)}`;
    const defaultBalanceEffect: 'auto' | 'none' =
      input.snapshotMode === 'already_reflected_in_snapshot' ? 'none' : 'auto';

    // Capture full database undo state before running operations
    const allWsIds = this.getWorkspaces().map((w) => w.id);
    const beforeAccountsMap = new Map(this.listAccounts(allWsIds).map((a) => [a.id, a]));
    const rawAccountsBefore = this.db.prepare(`SELECT * FROM accounts`).all() as Array<Record<string, unknown>>;
    const rawExpensesBefore = this.db.prepare(`SELECT * FROM expenses`).all() as Array<Record<string, unknown>>;
    const rawTransfersBefore = this.db.prepare(`SELECT * FROM account_transfers`).all() as Array<Record<string, unknown>>;
    const rawOccurrencesBefore = this.db.prepare(`SELECT * FROM payment_occurrences`).all() as Array<Record<string, unknown>>;
    const rawObligationsBefore = this.db.prepare(`SELECT * FROM obligations`).all() as Array<Record<string, unknown>>;
    const rawLiabilitiesBefore = this.db.prepare(`SELECT * FROM liabilities`).all() as Array<Record<string, unknown>>;

    const savepointName = `sp_reconcile_${crypto.randomUUID().replace(/-/g, '')}`;
    this.db.exec(`SAVEPOINT ${savepointName};`);

    try {
      // 1. Validate expected pre-conditions
      for (const exp of input.expectedAccounts ?? []) {
        const acc = this.getAccountById(exp.accountId);
        if (!acc) {
          throw new Error(`Expected account "${exp.accountId}" not found`);
        }
        if (exp.expectedVersion !== undefined && (acc.version ?? 1) !== exp.expectedVersion) {
          throw new Error(
            `Precondition failed for account "${acc.name}": expected version ${exp.expectedVersion}, actual ${acc.version ?? 1}`
          );
        }
        if (
          exp.expectedAvailableBalanceMinor !== undefined &&
          acc.balanceMinor !== Math.round(exp.expectedAvailableBalanceMinor)
        ) {
          throw new Error(
            `Precondition failed for account "${acc.name}": expected available balance ${exp.expectedAvailableBalanceMinor}, actual ${acc.balanceMinor}`
          );
        }
        if (
          exp.expectedBookedBalanceMinor !== undefined &&
          (acc.bookedBalanceMinor ?? acc.balanceMinor) !== Math.round(exp.expectedBookedBalanceMinor)
        ) {
          throw new Error(
            `Precondition failed for account "${acc.name}": expected booked balance ${exp.expectedBookedBalanceMinor}, actual ${acc.bookedBalanceMinor ?? acc.balanceMinor}`
          );
        }
      }

      const proposedChanges: Array<Record<string, unknown>> = [];
      const duplicateMatches: Array<Record<string, unknown>> = [];
      const unresolvedEvidence: Array<Record<string, unknown>> = [];
      const touchedAccountIds = new Set<string>();
      const persistedTransactions: ExpenseEntryRecord[] = [];
      const persistedTransfers: AccountTransferRecord[] = [];
      const persistedOccurrences: PaymentOccurrenceRecord[] = [];
      const persistedObligations: ObligationRecord[] = [];

      // 2. Apply 'before_ops' snapshots
      const snapshots = input.accountSnapshots ?? [];
      for (const snap of snapshots.filter((s) => (s.timing ?? 'before_ops') === 'before_ops')) {
        touchedAccountIds.add(snap.accountId);
        const res = this.setAccountBalanceSnapshot(snap);
        proposedChanges.push({
          opType: 'account_snapshot',
          timing: 'before_ops',
          entityId: snap.accountId,
          action: 'update',
          beforeBalanceMinor: res.before.balanceMinor,
          afterBalanceMinor: res.after.balanceMinor,
        });
      }

      // 3. Apply transfers
      for (const trf of input.transfers ?? []) {
        touchedAccountIds.add(trf.fromAccountId);
        touchedAccountIds.add(trf.toAccountId);
        const res = this.createTransfer({
          ...trf,
          balanceEffect: trf.balanceEffect ?? defaultBalanceEffect,
        });
        persistedTransfers.push(res.transfer);
        persistedTransactions.push(res.outflowLeg, res.inflowLeg);
        proposedChanges.push({
          opType: 'transfer',
          entityId: res.transfer.id,
          action: res.idempotentReplay ? 'noop' : 'create',
          fromAccountId: res.transfer.fromAccountId,
          toAccountId: res.transfer.toAccountId,
          fromAmountMinor: res.transfer.fromAmountMinor,
          toAmountMinor: res.transfer.toAmountMinor,
          fromBeforeMinor: res.fromAccountBeforeMinor,
          fromAfterMinor: res.fromAccountAfterMinor,
          toBeforeMinor: res.toAccountBeforeMinor,
          toAfterMinor: res.toAccountAfterMinor,
        });
      }

      // 4. Apply transactions (detecting duplicates and unresolved evidence)
      for (const txInput of input.transactions ?? []) {
        if (txInput.accountId) touchedAccountIds.add(txInput.accountId);
        const existingMatch = this.findExistingTransaction({
          id: txInput.id,
          idempotencyKey: txInput.idempotencyKey,
          providerTxId: txInput.providerTxId,
        });
        if (!existingMatch && txInput.accountId && txInput.amountMinor !== undefined && txInput.spentDate) {
          // Check fuzzy duplicate on same account + date + amount
          const fuzzy = this.db
            .prepare(
              `SELECT id, merchant, spent_date, amount_minor, status
               FROM expenses
               WHERE account_id = ? AND amount_minor = ? AND substr(spent_date, 1, 10) = ?
               LIMIT 1`
            )
            .get(txInput.accountId, Math.round(txInput.amountMinor), txInput.spentDate.slice(0, 10)) as
            | Record<string, unknown>
            | undefined;
          if (fuzzy) {
            duplicateMatches.push({
              candidateId: String(fuzzy.id),
              merchant: String(fuzzy.merchant),
              spentDate: String(fuzzy.spent_date),
              amountMinor: Number(fuzzy.amount_minor),
              matchType: 'same_account_date_amount',
            });
          }
        } else if (existingMatch) {
          duplicateMatches.push({
            candidateId: existingMatch.id,
            merchant: existingMatch.merchant,
            spentDate: existingMatch.spentDate,
            amountMinor: existingMatch.amountMinor,
            matchType: txInput.id ? 'id' : txInput.idempotencyKey ? 'idempotency_key' : 'provider_tx_id',
          });
        }

        const res = this.upsertTransaction({
          ...txInput,
          balanceEffect: txInput.balanceEffect ?? defaultBalanceEffect,
        });
        if (res.transaction.accountId) touchedAccountIds.add(res.transaction.accountId);
        persistedTransactions.push(res.transaction);

        if (
          res.transaction.kind === 'expense' &&
          !res.transaction.potId &&
          res.transaction.status !== 'reversed'
        ) {
          unresolvedEvidence.push({
            entityType: 'transaction',
            entityId: res.transaction.id,
            merchant: res.transaction.merchant,
            amountMinor: res.transaction.amountMinor,
            spentDate: res.transaction.spentDate,
            reason: 'uncategorized_missing_pot_or_receipt',
          });
        }
        if (res.transaction.status === 'pending') {
          unresolvedEvidence.push({
            entityType: 'transaction',
            entityId: res.transaction.id,
            merchant: res.transaction.merchant,
            amountMinor: res.transaction.amountMinor,
            spentDate: res.transaction.spentDate,
            reason: 'pending_bank_settlement',
          });
        }

        proposedChanges.push({
          opType: 'transaction',
          entityId: res.transaction.id,
          action: res.idempotentReplay ? 'noop' : res.created ? 'create' : 'update',
          merchant: res.transaction.merchant,
          amountMinor: res.transaction.amountMinor,
          status: res.transaction.status,
          availableDeltaMinor: res.availableDeltaMinor,
          bookedDeltaMinor: res.bookedDeltaMinor,
          accountBeforeBalanceMinor: res.accountBeforeBalanceMinor,
          accountAfterBalanceMinor: res.accountAfterBalanceMinor,
        });
      }

      // 5. Apply obligation payments
      for (const payInput of input.obligationPayments ?? []) {
        const res = this.recordObligationPayment({
          ...payInput,
          balanceEffect: payInput.balanceEffect ?? defaultBalanceEffect,
        });
        if (res.occurrence?.accountId) touchedAccountIds.add(res.occurrence.accountId);
        if (res.occurrence) persistedOccurrences.push(res.occurrence);
        persistedObligations.push(res.obligation);
        proposedChanges.push({
          opType: 'obligation_payment',
          entityId: res.occurrence?.id ?? payInput.obligationId,
          obligationId: res.obligation.id,
          action: res.idempotentReplay ? 'noop' : 'update',
          actualPaidMinor: res.occurrence?.actualPaidMinor ?? null,
          nextDueDate: res.obligation.nextDueDate,
          accountBeforeBalanceMinor: res.accountBeforeBalanceMinor,
          accountAfterBalanceMinor: res.accountAfterBalanceMinor,
        });
      }

      // 6. Apply obligation schedule updates
      for (const schedInput of input.obligationSchedules ?? []) {
        const res = this.updateObligationSchedule(schedInput);
        persistedObligations.push(res.obligation);
        persistedOccurrences.push(...res.updatedInstances);
        proposedChanges.push({
          opType: 'obligation_schedule',
          entityId: res.obligation.id,
          action: 'update',
          nextDueDate: res.obligation.nextDueDate,
          endDate: res.obligation.endDate ?? null,
          finalAmountMinor: res.obligation.finalAmountMinor ?? null,
          isActive: res.obligation.isActive,
        });
      }

      // 7. Apply 'after_ops' snapshots
      for (const snap of snapshots.filter((s) => s.timing === 'after_ops')) {
        touchedAccountIds.add(snap.accountId);
        const res = this.setAccountBalanceSnapshot(snap);
        proposedChanges.push({
          opType: 'account_snapshot',
          timing: 'after_ops',
          entityId: snap.accountId,
          action: 'update',
          beforeBalanceMinor: res.before.balanceMinor,
          afterBalanceMinor: res.after.balanceMinor,
        });
      }

      // 8. Validate post-conditions (`assertAfterAccounts`)
      for (const post of input.assertAfterAccounts ?? []) {
        touchedAccountIds.add(post.accountId);
        const acc = this.getAccountById(post.accountId);
        if (!acc) {
          throw new Error(`Postcondition account "${post.accountId}" not found`);
        }
        if (
          post.expectedAvailableBalanceMinor !== undefined &&
          acc.balanceMinor !== Math.round(post.expectedAvailableBalanceMinor)
        ) {
          throw new Error(
            `Postcondition failed for account "${acc.name}": expected available balance ${post.expectedAvailableBalanceMinor}, actual ${acc.balanceMinor}`
          );
        }
        if (
          post.expectedBookedBalanceMinor !== undefined &&
          (acc.bookedBalanceMinor ?? acc.balanceMinor) !== Math.round(post.expectedBookedBalanceMinor)
        ) {
          throw new Error(
            `Postcondition failed for account "${acc.name}": expected booked balance ${post.expectedBookedBalanceMinor}, actual ${acc.bookedBalanceMinor ?? acc.balanceMinor}`
          );
        }
      }

      // Build account balance before/after comparison
      const enrichedAfter = this.listAccountsEnriched(allWsIds);
      const accountBalances = enrichedAfter
        .filter((a) => touchedAccountIds.size === 0 || touchedAccountIds.has(a.id))
        .map((afterAcc) => {
          const beforeAcc = beforeAccountsMap.get(afterAcc.id);
          const beforeAvail = beforeAcc?.balanceMinor ?? afterAcc.availableBalanceMinor;
          const beforeBooked =
            beforeAcc?.bookedBalanceMinor ?? beforeAcc?.balanceMinor ?? afterAcc.bookedBalanceMinor;
          return {
            accountId: afterAcc.id,
            name: afterAcc.name,
            currency: afterAcc.currency,
            beforeAvailableMinor: beforeAvail,
            afterAvailableMinor: afterAcc.availableBalanceMinor,
            deltaAvailableMinor: afterAcc.availableBalanceMinor - beforeAvail,
            beforeBookedMinor: beforeBooked,
            afterBookedMinor: afterAcc.bookedBalanceMinor,
            versionBefore: beforeAcc?.version ?? 1,
            versionAfter: afterAcc.version ?? 1,
            lockedPreserveMinor: afterAcc.lockedPreserveMinor,
            fundedPreserveMinor: afterAcc.fundedPreserveMinor,
            unfundedPreserveShortfallMinor: afterAcc.unfundedPreserveShortfallMinor,
            trueAvailableMinor: afterAcc.trueAvailableMinor,
          };
        });

      const summaryPayload = {
        batchId,
        dryRun,
        idempotentReplay: false,
        proposedChanges,
        duplicateMatches,
        unresolvedEvidence,
        accountBalances,
        totals: {
          snapshotsApplied: snapshots.length,
          transfersProcessed: (input.transfers ?? []).length,
          transactionsProcessed: (input.transactions ?? []).length,
          obligationPaymentsProcessed: (input.obligationPayments ?? []).length,
          scheduleUpdatesProcessed: (input.obligationSchedules ?? []).length,
        },
        persistedRecords: {
          accounts: enrichedAfter.filter((a) => touchedAccountIds.has(a.id)),
          transactions: persistedTransactions,
          transfers: persistedTransfers,
          paymentOccurrences: persistedOccurrences,
          obligations: persistedObligations,
        },
      };

      if (dryRun) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepointName};`);
        this.db.exec(`RELEASE SAVEPOINT ${savepointName};`);
        return summaryPayload;
      }

      const undoLog = {
        accounts: rawAccountsBefore,
        expenses: rawExpensesBefore,
        transfers: rawTransfersBefore,
        occurrences: rawOccurrencesBefore,
        obligations: rawObligationsBefore,
        liabilities: rawLiabilitiesBefore,
      };

      this.db
        .prepare(
          `INSERT INTO reconciliation_batches (id, user_id, idempotency_key, status, summary_json, undo_log_json, created_at)
           VALUES (?, ?, ?, 'applied', ?, ?, ?)`
        )
        .run(
          batchId,
          userId,
          input.idempotencyKey ?? null,
          JSON.stringify(summaryPayload),
          JSON.stringify(undoLog),
          new Date().toISOString()
        );

      this.db.exec(`RELEASE SAVEPOINT ${savepointName};`);
      return summaryPayload;
    } catch (err) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${savepointName};`);
      this.db.exec(`RELEASE SAVEPOINT ${savepointName};`);
      throw err;
    }
  }

  public reverseReconciliationBatch(userId: string, batchId: string) {
    const row = this.db
      .prepare(`SELECT * FROM reconciliation_batches WHERE id = ?`)
      .get(batchId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Reconciliation batch "${batchId}" not found`);
    }
    if (row.status === 'reversed') {
      return {
        batchId,
        status: 'reversed',
        reversed: true,
        idempotentReplay: true,
        reversedAt: String(row.reversed_at),
      };
    }

    const undoLog = JSON.parse(String(row.undo_log_json)) as {
      accounts: Array<Record<string, unknown>>;
      expenses: Array<Record<string, unknown>>;
      transfers: Array<Record<string, unknown>>;
      occurrences: Array<Record<string, unknown>>;
      obligations: Array<Record<string, unknown>>;
      liabilities: Array<Record<string, unknown>>;
    };

    const restoreTable = (tableName: string, rows: Array<Record<string, unknown>>) => {
      this.db.exec(`DELETE FROM ${tableName};`);
      if (!rows.length) return;
      const cols = Object.keys(rows[0]);
      const placeholders = cols.map(() => '?').join(',');
      const stmt = this.db.prepare(
        `INSERT INTO ${tableName} (${cols.join(',')}) VALUES (${placeholders})`
      );
      for (const r of rows) {
        stmt.run(...cols.map((c) => (r[c] ?? null) as string | number | null));
      }
    };

    const savepointName = `sp_rev_${crypto.randomUUID().replace(/-/g, '')}`;
    this.db.exec(`SAVEPOINT ${savepointName};`);
    try {
      restoreTable('account_transfers', undoLog.transfers);
      restoreTable('payment_occurrences', undoLog.occurrences);
      restoreTable('expenses', undoLog.expenses);
      restoreTable('obligations', undoLog.obligations);
      restoreTable('liabilities', undoLog.liabilities);
      restoreTable('accounts', undoLog.accounts);

      const reversedAt = new Date().toISOString();
      this.db
        .prepare(`UPDATE reconciliation_batches SET status = 'reversed', reversed_at = ? WHERE id = ?`)
        .run(reversedAt, batchId);
      this.db.exec(`RELEASE SAVEPOINT ${savepointName};`);
      return {
        batchId,
        status: 'reversed',
        reversed: true,
        idempotentReplay: false,
        reversedAt,
      };
    } catch (err) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${savepointName};`);
      this.db.exec(`RELEASE SAVEPOINT ${savepointName};`);
      throw err;
    }
  }
}
