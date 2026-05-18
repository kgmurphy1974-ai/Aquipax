// netlify/functions/check-subscription.js
// Called by app to verify premium status from Stripe directly

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return { statusCode: 200, body: JSON.stringify({ isPremium: false, reason: 'not_configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request' }) };
  }

  const { customerId } = body;
  if (!customerId) {
    return { statusCode: 200, body: JSON.stringify({ isPremium: false }) };
  }

  try {
    const response = await fetch(
      `https://api.stripe.com/v1/subscriptions?customer=${customerId}&status=active&limit=1`,
      { headers: { 'Authorization': `Bearer ${stripeKey}` } }
    );
    const data = await response.json();
    const isPremium = data.data && data.data.length > 0;
    const subscription = isPremium ? data.data[0] : null;

    return {
      statusCode: 200,
      body: JSON.stringify({
        isPremium,
        status: subscription?.status || 'none',
        currentPeriodEnd: subscription?.current_period_end || null,
        cancelAtPeriodEnd: subscription?.cancel_at_period_end || false
      })
    };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ isPremium: false, error: err.message }) };
  }
};
