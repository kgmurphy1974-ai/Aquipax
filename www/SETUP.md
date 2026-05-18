# Aquipax by JeanieIQ — Deployment Guide

## What's in this folder

| File | Purpose |
|---|---|
| `index.html` | Sign-in / sign-up page |
| `app.html` | The full Aquipax app (2,100+ lines) |
| `admin.html` | Admin dashboard |
| `manifest.json` | PWA installability config |
| `sw.js` | Service worker (caching + push notifications) |
| `netlify.toml` | Hosting & routing config |
| `spendiq_logo_app.png` | App logo (dark background) |
| `spendiq_logo_signin.png` | Sign-in page logo |
| `icon-192.png` / `icon-512.png` | PWA icons |

---

## Step 1 — Supabase (database & auth)

1. Go to [supabase.com](https://supabase.com) and create a project
2. In **SQL Editor**, run:

```sql
create table user_data (
  user_id uuid references auth.users(id) on delete cascade primary key,
  data jsonb,
  updated_at timestamptz default now()
);
alter table user_data enable row level security;
create policy "Users can read own data" on user_data for select using (auth.uid() = user_id);
create policy "Users can upsert own data" on user_data for insert using (auth.uid() = user_id);
create policy "Users can update own data" on user_data for update using (auth.uid() = user_id);
```

3. Go to **Project Settings → API** and copy:
   - Project URL
   - anon/public key
   - service_role key (keep secret)

4. Replace in `index.html` and `app.html`:
```js
const SUPABASE_URL      = 'YOUR_PROJECT_URL';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
```

---

## Step 2 — Stripe (payments)

1. Create a [Stripe](https://stripe.com) account
2. Create two products in Stripe dashboard:
   - **Aquipax Plus Monthly** — £2.99/month recurring
   - **Aquipax Plus Yearly** — £24.99/year recurring
   - **Aquipax Family Monthly** — £4.99/month recurring
   - **Aquipax Family Yearly** — £39.99/year recurring
3. Copy the Price IDs (start with `price_`)

---

## Step 3 — Anthropic (AI receipt scanning)

1. Create an account at [console.anthropic.com](https://console.anthropic.com)
2. Generate an API key

---

## Step 4 — RapidAPI (live supermarket prices)

1. Sign up at [rapidapi.com](https://rapidapi.com)
2. Subscribe to the **UK Supermarkets Product Pricing** API by Pear Data
3. Copy your RapidAPI key

---

## Step 5 — Deploy to Netlify

1. Go to [netlify.com](https://netlify.com) → Add new site → Deploy manually
2. Drag and drop this folder
3. Go to **Site settings → Environment variables** and add:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic key |
| `RAPIDAPI_KEY` | Your RapidAPI key |
| `STRIPE_SECRET_KEY` | Your Stripe secret key (sk_live_...) |
| `STRIPE_WEBHOOK_SECRET` | From Stripe webhook dashboard |
| `STRIPE_PRICE_MONTHLY` | price_xxx for Plus monthly |
| `STRIPE_PRICE_YEARLY` | price_xxx for Plus yearly |
| `STRIPE_PRICE_FAMILY_MONTHLY` | price_xxx for Family monthly |
| `STRIPE_PRICE_FAMILY_YEARLY` | price_xxx for Family yearly |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Your Supabase service_role key |

4. In Stripe dashboard → Webhooks → Add endpoint:
   - URL: `https://your-site.netlify.app/.netlify/functions/stripe-webhook`
   - Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
   - Copy the webhook signing secret → set as `STRIPE_WEBHOOK_SECRET`

---

## Pricing tiers

| Tier | Price | Features |
|---|---|---|
| Free | £0 | Full financial planner, fuel prices, calendar, meal planner, health tracking |
| Plus | £2.99/mo or £24.99/yr | + Receipt scanner, live prices, nutrition, year history, PDF reports, cloud sync |
| Family | £4.99/mo or £39.99/yr | Everything in Plus + 4 profiles, shared calendar |

---

## Costs at scale

| Service | Cost |
|---|---|
| Netlify hosting | Free (or £15/mo Pro) |
| Supabase | Free up to 50k users |
| Anthropic (Claude) | ~£0.03 per receipt scan |
| RapidAPI prices | ~£0.08 per scan ($0.10) |
| Stripe | 1.4% + 20p per transaction |
| Open Food Facts | Free |
