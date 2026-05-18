// netlify/functions/track-referral.js
// Records a referral when a new user signs up via a referral link
// Also checks if the referrer has hit 10 referrals and grants free months
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, STRIPE_SECRET_KEY

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const stripeKey = process.env.STRIPE_SECRET_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { referralCode, newUserId, newUserEmail } = body;

    if (!referralCode || !newUserId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'referralCode and newUserId required' }) };
    }

    // Helper: call Supabase REST API
    const supabase = async (path, method = 'GET', data = null) => {
      const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
        method,
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
        },
        body: data ? JSON.stringify(data) : undefined
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Supabase ${method} ${path}: ${err}`);
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    };

    // 1. Find the referrer by their referral code
    // The referral code is the first 8 chars of their user_id (uppercase)
    // We need to find which user has this code
    const referrerId = referralCode.toLowerCase(); // partial user ID

    // Look up the referrer's user_data row
    const referrerRows = await supabase(
      `user_data?select=user_id,data&user_id=ilike.${referrerId}%25`,
      'GET'
    );

    if (!referrerRows || referrerRows.length === 0) {
      // Referral code not found — still record the signup but no reward
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, message: 'Referral code not found', rewarded: false })
      };
    }

    const referrer = referrerRows[0];
    const referrerId_full = referrer.user_id;

    // 2. Check if this new user has already been counted for this referrer
    // (prevent duplicate counting)
    const existingReferral = await supabase(
      `referrals?select=id&referrer_id=eq.${referrerId_full}&referred_id=eq.${newUserId}`,
      'GET'
    );

    if (existingReferral && existingReferral.length > 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, message: 'Already counted', rewarded: false })
      };
    }

    // 3. Record the referral
    await supabase('referrals', 'POST', {
      referrer_id: referrerId_full,
      referred_id: newUserId,
      referred_email: newUserEmail || null,
      created_at: new Date().toISOString()
    });

    // 4. Count total referrals for this referrer
    const allReferrals = await supabase(
      `referrals?select=id&referrer_id=eq.${referrerId_full}`,
      'GET'
    );
    const totalReferrals = allReferrals ? allReferrals.length : 0;

    // 5. Update the referrer's state with new count
    const referrerData = referrer.data || {};
    referrerData.referralCount = totalReferrals;

    // Check if they've hit a milestone (every 3 referrals = 3 free months)
    const previousCount = (referrer.data?.referralCount || 0);
    const newMilestone = Math.floor(totalReferrals / 3) > Math.floor(previousCount / 3);

    if (newMilestone) {
      referrerData.referralFreeMonths = (referrerData.referralFreeMonths || 0) + 3;

      // Extend their Stripe subscription by 12 months if they have one
      if (stripeKey && referrerData.stripeCustomerId) {
        try {
          // Get their current subscription
          const subRes = await fetch(
            `https://api.stripe.com/v1/subscriptions?customer=${referrerData.stripeCustomerId}&status=active&limit=1`,
            { headers: { 'Authorization': `Bearer ${stripeKey}` } }
          );
          const subData = await subRes.json();
          const sub = subData.data?.[0];

          if (sub) {
            // Extend trial by 365 days from now or from current trial end
            const currentEnd = sub.trial_end || Math.floor(Date.now() / 1000);
            const newEnd = currentEnd + (90 * 24 * 60 * 60); // 3 months = 90 days

            await fetch(`https://api.stripe.com/v1/subscriptions/${sub.id}`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${stripeKey}`,
                'Content-Type': 'application/x-www-form-urlencoded'
              },
              body: `trial_end=${newEnd}`
            });
          }
        } catch (stripeErr) {
          console.error('Stripe extension failed:', stripeErr.message);
          // Don't fail the whole request if Stripe extension fails
        }
      }
    }

    // Update referrer's data in Supabase
    await supabase(
      `user_data?user_id=eq.${referrerId_full}`,
      'PATCH',
      { data: referrerData, updated_at: new Date().toISOString() }
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        totalReferrals,
        milestone: newMilestone,
        freeMonthsGranted: newMilestone ? 12 : 0
      })
    };

  } catch (err) {
    console.error('Referral tracking error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Referral tracking failed: ' + err.message })
    };
  }
};
