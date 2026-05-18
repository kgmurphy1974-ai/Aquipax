// netlify/functions/create-checkout.js
// Creates a Stripe Checkout session for Aquipax Premium

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Stripe not configured' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request' }) };
  }

  const { userId, email, plan } = body;
  if (!userId || !email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing userId or email' }) };
  }

  // Price IDs — set these after creating products in Stripe dashboard
  const prices = {
    monthly:        process.env.STRIPE_PRICE_MONTHLY,
    yearly:         process.env.STRIPE_PRICE_YEARLY,
    family_monthly: process.env.STRIPE_PRICE_FAMILY_MONTHLY,
    family_yearly:  process.env.STRIPE_PRICE_FAMILY_YEARLY,
  };

  const priceId = prices[plan] || prices.monthly;
  if (!priceId) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Price not configured. Set STRIPE_PRICE_MONTHLY in Netlify env vars.' }) };
  }

  const origin = event.headers.origin || 'https://aquipax.com';

  try {
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        'mode': 'subscription',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        'customer_email': email,
        'client_reference_id': userId,
        'success_url': `${origin}/app.html?premium=success&plan=${plan||'monthly'}`,
        'cancel_url': `${origin}/app.html?premium=cancelled`,
        'allow_promotion_codes': 'true',
        'billing_address_collection': 'auto',
        'metadata[userId]': userId,
        'metadata[source]': 'aquipax_app',
        'subscription_data[metadata][userId]': userId,
        'subscription_data[trial_period_days]': '7',
      }).toString()
    });

    const session = await response.json();

    if (session.error) {
      return { statusCode: 400, body: JSON.stringify({ error: session.error.message }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ url: session.url })
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
