import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_FX_RATES } from '../shared/currency.js';
import type {
  AssetBelongingRecord,
  AttachmentRecord,
  AuthProviderKind,
  BankAccountRecord,
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
    addColumnIfMissing('obligations', 'account_id', 'TEXT REFERENCES accounts(id) ON DELETE SET NULL');
    addColumnIfMissing('obligations', 'liability_id', 'TEXT REFERENCES liabilities(id) ON DELETE SET NULL');
    addColumnIfMissing('payment_occurrences', 'account_id', 'TEXT REFERENCES accounts(id) ON DELETE SET NULL');
    addColumnIfMissing('payment_occurrences', 'liability_id', 'TEXT REFERENCES liabilities(id) ON DELETE SET NULL');
    addColumnIfMissing('payment_occurrences', 'liability_delta_minor', 'INTEGER NOT NULL DEFAULT 0');
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
    insertUser.run('usr-wadera', 'wadera', 'Wadera', 'pstopa@skyday.eu', 'GBP', 'ws-wadera');
    insertUser.run('usr-walter', 'walter', 'Walter', 'poznanski.wojciech@gmail.com', 'GBP', 'ws-walter');
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

  public listAccounts(workspaceIds: string[]): BankAccountRecord[] {
    if (!workspaceIds.length) return [];
    const placeholders = workspaceIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM accounts WHERE workspace_id IN (${placeholders}) ORDER BY name`)
      .all(...workspaceIds) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      name: String(r.name),
      institution: String(r.institution ?? ''),
      currency: r.currency as CurrencyCode,
      balanceMinor: Number(r.balance_minor),
      isPrimaryRunway: Boolean(r.is_primary_runway),
      portalUrl: (r.portal_url as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      updatedAt: String(r.updated_at),
    }));
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

  public listObligations(workspaceIds: string[]): ObligationRecord[] {
    if (!workspaceIds.length) return [];
    const placeholders = workspaceIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM obligations WHERE workspace_id IN (${placeholders}) ORDER BY next_due_date, name`)
      .all(...workspaceIds) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      potId: (r.pot_id as string | null) ?? null,
      accountId: (r.account_id as string | null) ?? null,
      liabilityId: (r.liability_id as string | null) ?? null,
      name: String(r.name),
      amountMinor: Number(r.amount_minor),
      currency: r.currency as CurrencyCode,
      cadence: r.cadence as ObligationRecord['cadence'],
      intervalMonths: Number(r.interval_months),
      nextDueDate: String(r.next_due_date),
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
    }));
  }

  public listPaymentOccurrences(yearMonth: string, obligationIds: string[]): PaymentOccurrenceRecord[] {
    if (!obligationIds.length) return [];
    const placeholders = obligationIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM payment_occurrences WHERE year_month = ? AND obligation_id IN (${placeholders}) ORDER BY due_date`
      )
      .all(yearMonth, ...obligationIds) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
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
      notes: (r.notes as string | null) ?? null,
    }));
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
    sql += ` ORDER BY spent_date DESC, created_at DESC`;
    const rows = this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      potId: (r.pot_id as string | null) ?? null,
      accountId: (r.account_id as string | null) ?? null,
      liabilityId: (r.liability_id as string | null) ?? null,
      flowDirection: r.flow_direction === 'inflow' ? 'inflow' : 'outflow',
      merchant: String(r.merchant),
      description: String(r.description ?? ''),
      amountMinor: Number(r.amount_minor),
      currency: r.currency as CurrencyCode,
      spentDate: String(r.spent_date),
      tags: JSON.parse(String(r.tags_json || '[]')) as string[],
      portalUrl: (r.portal_url as string | null) ?? null,
      source: r.source as ExpenseEntryRecord['source'],
      items: JSON.parse(String(r.items_json || '[]')) as ExpenseSubItem[],
      createdAt: String(r.created_at),
    }));
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
}
