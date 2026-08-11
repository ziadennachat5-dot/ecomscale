# EcomOS · Morocco COD ERP

A real-time e-commerce operations dashboard for Moroccan COD (Cash on Delivery) businesses.
Tracks orders through confirmation → shipping → delivery,
and shows live P&L, ROAS, CPA and profit margin.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite + TypeScript + Tailwind CSS |
| Database | Supabase (PostgreSQL + Realtime) |
| Auth | Supabase Auth (email/password) |
| Server logic | Supabase Edge Functions (Deno) |
| Charts | Recharts |
| Routing | React Router v6 |

---

## Project layout

```
ecomos/
├── src/
│   ├── components/        UI building blocks (Layout, Sidebar, StatCard …)
│   ├── hooks/             Data hooks (useAuth, useOrders, useDashboardData …)
│   ├── lib/               supabase.ts client, types.ts, oauth.ts helpers
│   └── pages/             One file per route
├── supabase/
│   ├── migrations/        001_initial_schema.sql  ← run this first
│   └── functions/
│       ├── google-oauth-callback/   exchanges code → token (secret server-side)
│       └── disconnect-integration/  deletes a stored token
├── .env                   your public env vars (DO NOT commit)
└── .env.example           template (safe to commit)
```

---

## Setup — step by step

### 1. Install dependencies

```bash
npm install
```

### 2. Run the database migration

Open your Supabase project → **SQL Editor**, paste and run the contents of:

```
supabase/migrations/001_initial_schema.sql
```

This creates every table, RLS policy, the `integration_status` view, and the
auto-profile trigger.

### 3. Enable Realtime (optional but recommended)

In Supabase → **Database → Replication**, toggle on the `orders` and `shipments` tables.
This makes the Confirmation queue update live without a page refresh.

### 4. Register Edge Function secrets

**Never** put these in `.env` or any frontend file. Register them once with the
Supabase CLI:

```bash
supabase secrets set \
  SUPABASE_URL=https://wxfialbmyfkafobtkrde.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=sb_secret_FDOt0gbJvkvoK9JgdQ9xwQ_nl76oc0C \
  GOOGLE_CLIENT_ID=663048931798-egisotaudnusp59h0lbqka0f699mh6iq.apps.googleusercontent.com \
  GOOGLE_CLIENT_SECRET=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 \
  GOOGLE_REDIRECT_URI=http://localhost:8080/api/google/callback
```

### 5. Deploy the Edge Functions

```bash
supabase functions deploy google-oauth-callback
supabase functions deploy disconnect-integration
```

### 6. Configure Google OAuth redirect

In Google Cloud Console → Credentials → your OAuth 2.0 Client ID,
add these to **Authorized redirect URIs**:

```
http://localhost:8080/api/google/callback        (dev)
https://yourdomain.com/api/google/callback       (production)
```

### 7. Start the dev server

```bash
npm run dev
```

Open http://localhost:8080, create an account, and you're in.

---

## Security model

| What | Where | Exposed to browser? |
|---|---|---|
| `VITE_SUPABASE_URL` | `.env` / Vite | ✅ Yes (public) |
| `VITE_SUPABASE_ANON_KEY` | `.env` / Vite | ✅ Yes (public) |
| `VITE_GOOGLE_CLIENT_ID` | `.env` / Vite | ✅ Yes (public) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase secrets only | ❌ Never |
| `GOOGLE_CLIENT_SECRET` | Supabase secrets only | ❌ Never |
| OAuth `access_token` / `refresh_token` | `integrations` table, no RLS SELECT | ❌ Never |

Row Level Security is enabled on every table. The `integrations` table has
**no SELECT policy** so browsers can never read tokens directly — only
Edge Functions running with the service role key can.

---

## Production deployment

1. Build: `npm run build` → deploy `dist/` to Vercel, Netlify, or any static host
2. Update redirect URI in Google to your production domain
3. Re-run `supabase secrets set` with production URIs
4. Re-deploy Edge Functions: `supabase functions deploy --all`

---

## Pages

| Route | Description |
|---|---|
| `/` | Dashboard — live KPIs, revenue chart, top cities/products/campaigns |
| `/orders` | Full order CRM — search, filter by status, export CSV, create order |
| `/confirmation` | Confirmation queue — one-click confirm or cancel pending orders |
| `/shipping` | Shipment tracker with shipping integrations |
| `/customers` | Customer directory with LTV and order counts |
| `/products` | Product catalog with cost, margin and stock |
| `/inventory` | Stock levels, low-stock alerts, inventory value |
| `/ads-manager` | Campaign ROAS, spend and attributed revenue |
| `/expenses` | Expense logger — ad spend, rent, salaries, packaging |
| `/reports` | 30-day P&L summary, order counts, CSV export |
| `/team` | Workspace members and roles |
| `/settings` | Integrations (Google), Store, Notifications, Taxes |
