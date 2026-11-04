# Skyday Finance & Budget (`finance.skyday.eu`)

Multi-user personal & shared household finance, automatic sinking-fund ("Preserve") budgeting, hierarchical pots, and long-horizon wealth/belongings tracking for SKYDAY (`Wadera` & `Walter`).

## Key Capabilities
- **Authentik SSO (`auth.skyday.eu`)**: Native OAuth2/OIDC (Authorization Code + PKCE S256) + ForwardAuth support with separate named accounts (`wadera`, `walter`) and per-workspace **Partner Privacy Scope** (`private` | `totals_only` | `readonly`).
- **Multi-Currency Support**: Configurable user default currency (`GBP`, `EUR`, `PLN`, `USD`, `CHF`) with editable fixed FX rates.
- **Automatic "Preserve" Sinking-Fund Engine**: Upcoming multi-month or one-time payments automatically budget `(Target - Preserved) / MonthsUntilDue` each month and reset cleanly upon `[✓] Mark as Paid`.
- **Hierarchical Pots & Progressive Granularity**: Nested pots (`Home -> Food -> Meat/Butter`, `Car -> Fuel/Insurance`) combining rough monthly envelopes with optional itemized receipts without double counting.
- **Friends `%`-Only Privacy Mode**: Toggleable frontend privacy shield (`% ONLY` button or `P` shortcut) hiding all nominal currency numbers while preserving Sankey, Runway, Pot, and Base-100 Wealth graphs.
- **Wealth & Belongings Registry**: Appreciating property, depreciating belongings (`Car`, `Moto`, `E-MTB`, `PC`), mortgages/loans, historical snapshots, and 5–20 year net-worth forecasts.
- **Vault & Actionable Portal Links**: Attach PDFs/photos + structured `Manage / Cancel` URLs on any obligation, expense, or asset.
- **MCP Receipt Connector**: Scoped `Bearer skf_...` API keys + JSON-RPC 2.0 endpoint at `POST /api/mcp`.

## Development & Build
```bash
npm install
npm test
npm run build
npm start
```
