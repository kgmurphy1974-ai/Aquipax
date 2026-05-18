// netlify/functions/send-push.js
// Sends VAPID web push notifications to household members
// Env vars: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY

const webpush = require('web-push');

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!vapidPublic || !vapidPrivate) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'VAPID keys not configured' }) };
  }

  webpush.setVapidDetails(
    'mailto:hello@jeanieiq.com',
    vapidPublic,
    vapidPrivate
  );

  try {
    const body = JSON.parse(event.body || '{}');
    const { householdId, title, message, url, excludeUserId } = body;

    if (!householdId || !title) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'householdId and title required' }) };
    }

    // Get all push subscriptions for this household
    const res = await fetch(
      `${supabaseUrl}/rest/v1/push_subscriptions?household_id=eq.${householdId}`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        }
      }
    );
    const subscriptions = await res.json();

    if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ sent: 0, message: 'No subscriptions found' }) };
    }

    const payload = JSON.stringify({
      title,
      body: message || title,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      url: url || '/app.html',
      tag: `aquipax-${Date.now()}`
    });

    let sent = 0;
    let failed = 0;
    const expiredEndpoints = [];

    for (const sub of subscriptions) {
      // Skip the sender
      if (excludeUserId && sub.user_id === excludeUserId) continue;

      try {
        await webpush.sendNotification(sub.subscription, payload);
        sent++;
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          // Subscription expired — remove it
          expiredEndpoints.push(sub.id);
        }
        failed++;
      }
    }

    // Clean up expired subscriptions
    if (expiredEndpoints.length > 0) {
      await fetch(
        `${supabaseUrl}/rest/v1/push_subscriptions?id=in.(${expiredEndpoints.join(',')})`,
        {
          method: 'DELETE',
          headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
        }
      );
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ sent, failed, total: subscriptions.length })
    };

  } catch (err) {
    console.error('Send push error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
