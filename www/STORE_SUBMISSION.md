# Aquipax — App Store Submission Guide

## Overview

Aquipax is a PWA (Progressive Web App). This means you can submit it to both Google Play and the Apple App Store **without writing any native code** — the web app you already have is the product.

---

## Route 1 — Google Play (Recommended first, easiest)

Google Play accepts PWAs via a format called **Trusted Web Activity (TWA)**. PWABuilder generates the APK for you automatically.

### Step 1 — Use PWABuilder

1. Go to [pwabuilder.com](https://www.pwabuilder.com)
2. Enter your live URL (e.g. `https://aquipax.netlify.app` or `https://aquipax.com`)
3. PWABuilder will analyse your manifest and score your PWA
4. Click **Package for stores**
5. Select **Android** → **Google Play**
6. Download the generated `.aab` (Android App Bundle) file

### Step 2 — Google Play Console

1. Go to [play.google.com/console](https://play.google.com/console)
2. Create a developer account — **one-time fee of $25**
3. Click **Create app**
4. Fill in the store listing (copy from the template below)
5. Upload your `.aab` file
6. Submit for review — typically approved within **1–3 days**

### Store Listing Template — Google Play

**App name:** Aquipax — Spend With Certainty

**Short description (80 chars):**
Know exactly what you can safely spend — every bill accounted for.

**Full description:**
```
Aquipax maps your complete financial year and tells you exactly what you can safely spend each month — after every bill, renewal, saving, and holiday fund is accounted for.

Stop guessing. Stop overspending. Start knowing your number.

WHAT AQUIPAX DOES
• Calculates your safe-to-spend number — what's genuinely yours after everything
• Tracks every bill, renewal, and annual cost (MOT, insurance, Christmas)
• Smooths your year — spreads big annual costs monthly so nothing catches you out
• Plans your holidays — works out exactly how much to save each month
• Scans receipts — AI reads your receipt and compares prices at Tesco, ASDA, Sainsbury's, Morrisons, Waitrose and more in real time
• Tracks nutrition — see the health score of your grocery basket
• Finds cheap fuel — live prices at 4,000+ UK stations
• Plans your meals — weekly meal planner with cost estimates
• Tracks your health — steps, weight, exercise alongside your finances

YOUR PRIVACY
All financial data is stored securely in your account. Receipt images are processed by AI and never stored. No ads, no data selling.

FREE & PLUS
Free: Full financial planner, fuel prices, meal planner, health tracking
Plus (£2.99/mo): Receipt scanner, live prices, year history, PDF reports, cloud sync
Family (£4.99/mo): Everything in Plus + 4 household profiles, shared calendar

by JeanieIQ
```

**Category:** Finance

**Content rating:** Everyone

**Tags:** budget, finance, money, bills, spending, savings, grocery, receipt scanner

---

## Route 2 — Apple App Store

Apple requires a Mac and an Apple Developer account. There are two approaches:

### Option A — PWABuilder (no Mac needed for the package, but you need Xcode to submit)

1. Go to [pwabuilder.com](https://www.pwabuilder.com) → Package for stores → **iOS**
2. Download the generated Xcode project
3. Open in Xcode on a Mac, set your Bundle ID to `com.aquipax.app`
4. Archive and upload to App Store Connect

### Option B — Median.co (easiest, no Mac needed at all)

1. Go to [median.co](https://median.co)
2. Enter your URL
3. They generate and submit the iOS app for you
4. Cost: ~$99/year — worth it to avoid the Xcode complexity

### App Store Listing Template

**App name:** Aquipax

**Subtitle:** Spend With Certainty

**Description:**
```
Know exactly what you can safely spend this month — with nothing hiding round the corner.

Aquipax maps your complete financial year: every bill, every renewal, every annual cost, every savings goal. Then it gives you one number: what's genuinely yours to spend.

FEATURES
‣ Safe-to-spend calculator — your real monthly number after everything
‣ Bill & renewal tracker — MOT, insurance, energy, broadband
‣ Annual cost smoother — Christmas, school uniforms, car tax spread monthly
‣ Holiday planner — save the right amount each month
‣ Receipt scanner — AI reads your receipt, compares prices live at 5 supermarkets
‣ Grocery nutrition — health score for your basket
‣ Live fuel prices — 4,000+ UK stations updated every 30 minutes
‣ Meal planner — plan your week, estimate costs
‣ Health tracker — steps, weight, exercise

SUBSCRIPTION
Free: Full financial planner, fuel, meal planner, health
Plus: £2.99/month or £24.99/year — receipt scanner, live prices, history, PDF reports
Family: £4.99/month or £39.99/year — up to 4 profiles, shared calendar

30-day free trial. Cancel anytime.

by JeanieIQ
```

**Keywords:** budget,finance,money,bills,savings,grocery,receipt,fuel,spending,tracker

**Category:** Finance

**Age rating:** 4+

---

## Assets Required for Both Stores

### Icons (already generated)
- ✅ `icon-192.png` — 192×192px
- ✅ `icon-512.png` — 512×512px

### Screenshots needed
Google Play requires at least 2 screenshots (1080×1920px recommended).
Apple App Store requires screenshots for iPhone 6.7" and 6.5" displays.

**Recommended screenshots to create:**
1. Splash screen with a quote
2. Home screen showing "Your number" (e.g. £847)
3. Receipt scanner with live price comparison
4. Financial year map (bar chart)
5. Fuel prices screen

### Feature Graphic (Google Play only)
1024×500px banner image — use the dark wordmark logo on navy background.

---

## Digital Asset Links (Google Play TWA requirement)

For the TWA to work properly, you need to add a `assetlinks.json` file to your site. PWABuilder generates this for you — you just need to host it at:

```
https://yourdomain.com/.well-known/assetlinks.json
```

Add this to your `netlify.toml`:
```toml
[[redirects]]
  from = "/.well-known/assetlinks.json"
  to = "/assetlinks.json"
  status = 200
```

PWABuilder will give you the exact content for `assetlinks.json` when you generate the Android package — it contains your app's signing key fingerprint.

---

## Checklist

### Before submitting to Google Play
- [ ] Live URL deployed on Netlify
- [ ] manifest.json accessible at `https://yourdomain.com/manifest.json`
- [ ] HTTPS enabled (Netlify does this automatically)
- [ ] Google Play developer account created ($25)
- [ ] PWABuilder package generated
- [ ] `assetlinks.json` hosted on your domain
- [ ] Store listing text ready (use template above)
- [ ] Screenshots prepared (min 2, 1080×1920px)
- [ ] Feature graphic prepared (1024×500px)

### Before submitting to Apple App Store
- [ ] Apple Developer account ($99/year)
- [ ] iOS package generated via PWABuilder or Median.co
- [ ] App Store listing text ready (use template above)
- [ ] Screenshots for iPhone 6.7" (1290×2796px) and 6.5" (1242×2688px)
- [ ] Privacy policy URL (already at `/privacy.html`)

---

## Timeline

| Step | Time |
|---|---|
| Deploy to Netlify | Today |
| Generate Android package via PWABuilder | 30 minutes |
| Submit to Google Play | 1 hour |
| Google Play review | 1–3 days |
| Apple Developer account setup | 1 day |
| iOS package + submission | 2–4 hours |
| Apple App Store review | 1–7 days |

**You could be live on Google Play within 3–4 days of deploying.**
