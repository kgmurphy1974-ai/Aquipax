// netlify/functions/meal-plan-store.js
// Save and load meal plans from Supabase meal_plans table
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  // Helper matching household.js pattern
  const sb = async (path, method = 'GET', data = null, extra = {}) => {
    const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      method,
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal',
        ...extra
      },
      body: data ? JSON.stringify(data) : undefined
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch(e) { return text; }
  };

  try {
    const body = JSON.parse(event.body || '{}');
    const { action, userId, plan, shoppingList, caloriesTarget, servings } = body;

    if (!userId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'userId required' }) };

    if (action === 'save') {
      // Try update first, then insert if not exists
      const existing = await sb(`meal_plans?user_id=eq.${userId}&select=id`);
      const updateData = {
        plan: plan,
        shopping_list: shoppingList || [],
        calories_target: caloriesTarget || null,
        servings: servings || 2,
        updated_at: new Date().toISOString()
      };

      if (Array.isArray(existing) && existing.length > 0) {
        // Update existing
        await sb(`meal_plans?user_id=eq.${userId}`, 'PATCH', updateData);
      } else {
        // Insert new
        await sb('meal_plans', 'POST', { user_id: userId, ...updateData, generated_at: new Date().toISOString() });
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    if (action === 'load') {
      const data = await sb(`meal_plans?user_id=eq.${userId}&limit=1`);
      if (Array.isArray(data) && data.length > 0) {
        return { statusCode: 200, headers, body: JSON.stringify({
          plan: data[0].plan,
          shoppingList: data[0].shopping_list || [],
          caloriesTarget: data[0].calories_target,
          servings: data[0].servings,
          generatedAt: data[0].generated_at
        })};
      }
      return { statusCode: 200, headers, body: JSON.stringify({ plan: null }) };
    }

    if (action === 'delete') {
      await sb(`meal_plans?user_id=eq.${userId}`, 'DELETE');
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    console.error('Meal plan store error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
