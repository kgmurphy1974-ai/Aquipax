// netlify/functions/tasks.js
// CRUD for activity_events and tasks tables
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
    const { action, table, userId, householdId, item, itemId, isFamily } = body;

    if (!userId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'userId required' }) };

    const tbl = table === 'tasks' ? 'tasks' : 'activity_events';

    if (action === 'list') {
      // Get personal + family items
      let query = `${tbl}?user_id=eq.${userId}&order=`;
      query += tbl === 'tasks' ? 'due_date.asc.nullslast,created_at.desc' : 'event_date.asc,start_time.asc';
      const personal = await sb(query);
      
      let family = [];
      if (householdId) {
        const familyQuery = `${tbl}?household_id=eq.${householdId}&is_family=eq.true&user_id=neq.${userId}&order=`;
        const familyOrder = tbl === 'tasks' ? 'due_date.asc.nullslast' : 'event_date.asc';
        family = await sb(familyQuery + familyOrder);
      }
      
      const all = [...(Array.isArray(personal) ? personal : []), ...(Array.isArray(family) ? family : [])];
      return { statusCode: 200, headers, body: JSON.stringify({ items: all }) };
    }

    if (action === 'save') {
      const data = {
        ...item,
        user_id: userId,
        household_id: householdId || null,
        is_family: isFamily || false,
        created_by: userId,
        updated_at: new Date().toISOString()
      };
      
      if (itemId) {
        // Update
        await sb(`${tbl}?id=eq.${itemId}&user_id=eq.${userId}`, 'PATCH', data);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, id: itemId }) };
      } else {
        // Insert
        data.created_at = new Date().toISOString();
        const result = await sb(tbl, 'POST', data);
        const id = Array.isArray(result) ? result[0]?.id : result?.id;
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, id, item: Array.isArray(result) ? result[0] : result }) };
      }
    }

    if (action === 'delete') {
      await sb(`${tbl}?id=eq.${itemId}&user_id=eq.${userId}`, 'DELETE');
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    if (action === 'complete') {
      // Toggle task completion
      await sb(`tasks?id=eq.${itemId}&user_id=eq.${userId}`, 'PATCH', {
        completed: item.completed,
        completed_at: item.completed ? new Date().toISOString() : null,
        updated_at: new Date().toISOString()
      });
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    console.error('Tasks error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
