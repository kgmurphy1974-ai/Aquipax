// netlify/functions/shopping-list.js
// Shared household shopping list — CRUD + real-time via Supabase
// Supports: add, remove, toggle (check/uncheck), clear-checked, get, import-from-meal-plan
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  // Supabase REST helper
  const sb = async (path, method = 'GET', data = null) => {
    const opts = {
      method,
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
      }
    };
    if (data) opts.body = JSON.stringify(data);
    const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, opts);
    if (method === 'DELETE' || method === 'PATCH') return null;
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  };

  try {
    const body = JSON.parse(event.body || '{}');
    const { action, userId, householdId, itemId, item, items } = body;

    if (!userId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'userId required' }) };
    }

    // Determine the list scope: household (shared) or personal
    // listKey is the household_id if in a household, else the user_id
    const listKey = householdId || userId;
    const isHousehold = !!householdId;

    // ── GET LIST ──
    if (action === 'get') {
      const rows = await sb(
        `shopping_list?list_key=eq.${listKey}&order=created_at.asc&select=*`
      );
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ items: rows || [] })
      };
    }

    // ── ADD ITEM ──
    if (action === 'add') {
      if (!item || !item.name) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'item.name required' }) };
      }
      const newItem = {
        list_key: listKey,
        name: item.name.trim(),
        category: item.category || 'Other',
        quantity: item.quantity || '',
        checked: false,
        added_by: item.addedBy || userId,
        added_by_name: item.addedByName || 'You',
        source: item.source || 'manual', // 'manual' | 'meal-plan'
        created_at: new Date().toISOString()
      };
      const result = await sb('shopping_list', 'POST', newItem);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, item: result?.[0] || newItem })
      };
    }

    // ── ADD MULTIPLE ITEMS (e.g. from meal plan) ──
    if (action === 'add-many') {
      if (!items || !Array.isArray(items)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'items array required' }) };
      }
      const now = new Date().toISOString();
      const rows = items.map(i => ({
        list_key: listKey,
        name: (i.name || i).toString().trim(),
        category: i.category || 'Groceries',
        quantity: i.quantity || '',
        checked: false,
        added_by: userId,
        added_by_name: i.addedByName || 'Meal Plan',
        source: 'meal-plan',
        created_at: now
      })).filter(r => r.name.length > 1);

      // Insert in batches of 20
      const inserted = [];
      for (let i = 0; i < rows.length; i += 20) {
        const batch = rows.slice(i, i + 20);
        const result = await sb('shopping_list', 'POST', batch);
        if (result) inserted.push(...result);
      }
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, added: inserted.length })
      };
    }

    // ── TOGGLE CHECKED ──
    if (action === 'toggle') {
      if (!itemId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'itemId required' }) };
      }
      // Get current state
      const current = await sb(`shopping_list?id=eq.${itemId}&list_key=eq.${listKey}&select=checked`);
      const currentChecked = current?.[0]?.checked || false;
      await sb(
        `shopping_list?id=eq.${itemId}&list_key=eq.${listKey}`,
        'PATCH',
        { checked: !currentChecked, checked_by: userId, checked_at: new Date().toISOString() }
      );
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, checked: !currentChecked })
      };
    }

    // ── REMOVE ITEM ──
    if (action === 'remove') {
      if (!itemId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'itemId required' }) };
      }
      await sb(`shopping_list?id=eq.${itemId}&list_key=eq.${listKey}`, 'DELETE');
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // ── CLEAR CHECKED ITEMS ──
    if (action === 'clear-checked') {
      await sb(`shopping_list?list_key=eq.${listKey}&checked=eq.true`, 'DELETE');
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // ── CLEAR ALL ──
    if (action === 'clear-all') {
      await sb(`shopping_list?list_key=eq.${listKey}`, 'DELETE');
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    console.error('Shopping list error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Shopping list operation failed: ' + err.message })
    };
  }
};
