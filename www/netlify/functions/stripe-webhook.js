// netlify/functions/stripe-webhook.js
// Handles Stripe subscription lifecycle events with proper signature verification
// Env vars: STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY

const crypto = require('crypto');

// Verify Stripe webhook signature (HMAC-SHA256)
function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  try {
    const parts = sigHeader.split(',').reduce((acc, part) => {
      const [k, v] = part.split('=');
      acc[k] = v;
      return acc;
    }, {});
    const timestamp = parts['t'];
    const signature = parts['v1'];
    if (!timestamp || !signature) return false;
    // Reject events older than 5 minutes
    if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) return false;
    const signedPayload = `${timestamp}.${payload}`;
    const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch (e) {
    return false;
  }
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripeKey     = process.env.STRIPE_SECRET_KEY;
  const supabaseUrl   = process.env.SUPABASE_URL || 'https://facgysdopixzxviiljhh.supabase.co';
  const supabaseKey   = process.env.SUPABASE_SERVICE_KEY;

  const sig = event.headers['stripe-signature'];
  const rawBody = event.body;

  // Verify signature in production
  if (webhookSecret) {
    const valid = verifyStripeSignature(rawBody, sig, webhookSecret);
    if (!valid) {
      console.error('Stripe signature verification failed');
      return { statusCode: 400, body: 'Webhook signature verification failed' };
    }
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  try {
    switch (stripeEvent.type) {

      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const userId = session.client_reference_id || session.metadata?.userId;
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        const plan = session.metadata?.plan || 'monthly';
        console.log(`✅ New subscription: user=${userId} plan=${plan}`);
        if (supabaseKey && userId) {
          await updateUserPremium(supabaseUrl, supabaseKey, userId, {
            isPremium: true,
            premiumPlan: plan,
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
            premiumSince: new Date().toISOString(),
          });
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = stripeEvent.data.object;
        const userId = sub.metadata?.userId;
        const status = sub.status;
        const plan = sub.metadata?.plan || 'monthly';
        console.log(`🔄 Subscription updated: user=${userId} status=${status}`);
        if (supabaseKey && userId) {
          await updateUserPremium(supabaseUrl, supabaseKey, userId, {
            isPremium: status === 'active' || status === 'trialing',
            premiumPlan: plan,
            subscriptionStatus: status,
          });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object;
        const userId = sub.metadata?.userId;
        console.log(`❌ Subscription cancelled: user=${userId}`);
        if (supabaseKey && userId) {
          await updateUserPremium(supabaseUrl, supabaseKey, userId, {
            isPremium: false,
            premiumPlan: '',
            premiumCancelledAt: new Date().toISOString(),
          });
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object;
        console.log(`⚠️ Payment failed for customer: ${invoice.customer}`);
        // TODO: send email notification via SendGrid/Resend
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = stripeEvent.data.object;
        console.log(`💳 Payment succeeded for customer: ${invoice.customer}`);
        break;
      }

      default:
        console.log(`Unhandled event type: ${stripeEvent.type}`);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };

  } catch (err) {
    console.error('Webhook handler error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

async function updateUserPremium(supabaseUrl, supabaseKey, userId, data) {
  try {
    const getRes = await fetch(`${supabaseUrl}/rest/v1/user_data?user_id=eq.${userId}&select=data`, {
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
    });
    const rows = await getRes.json();
    const current = rows[0]?.data || {};
    const updated = { ...current, ...data };
    await fetch(`${supabaseUrl}/rest/v1/user_data`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ user_id: userId, data: updated, updated_at: new Date().toISOString() })
    });
    console.log(`Updated premium status for user ${userId}:`, data);
  } catch (e) {
    console.error('updateUserPremium error:', e.message);
  }
}
