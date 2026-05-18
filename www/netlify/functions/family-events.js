// netlify/functions/family-events.js
// Family planner events CRUD — shared across household members
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

  const sb = (path, opts = {}) => fetch(`${supabaseUrl}/rest/v1/${path}`, {
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Prefer': 'return=representation',
      ...opts.headers
    },
    ...opts
  });

  try {
    const body = JSON.parse(event.body || '{}');
    const { action, householdId, userId, userName, event: evt, eventId } = body;

    if (!householdId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'householdId required' }) };

    switch (action) {
      case 'get': {
        // Get events for the next 90 days + past 30 days
        const from = new Date();
        from.setDate(from.getDate() - 30);
        const to = new Date();
        to.setDate(to.getDate() + 90);
        const res = await sb(`family_events?household_id=eq.${householdId}&event_date=gte.${from.toISOString().slice(0,10)}&event_date=lte.${to.toISOString().slice(0,10)}&order=event_date.asc,start_time.asc`);
        const data = await res.json();
        return { statusCode: 200, headers, body: JSON.stringify({ events: data }) };
      }

      case 'add': {
        if (!evt || !evt.title || !evt.event_date) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'title and event_date required' }) };
        }
        const res = await sb('family_events', {
          method: 'POST',
          body: JSON.stringify({
            household_id: householdId,
            created_by: userId,
            created_by_name: userName || 'Someone',
            title: evt.title.trim(),
            description: evt.description || null,
            event_date: evt.event_date,
            start_time: evt.start_time || null,
            end_time: evt.end_time || null,
            all_day: evt.all_day || false,
            members: evt.members || [],
            category: evt.category || 'general',
            colour: evt.colour || '#1a7fe8',
            location: evt.location || null,
            recurring: evt.recurring || 'none'
          })
        });
        const data = await res.json();
        return { statusCode: 200, headers, body: JSON.stringify({ event: Array.isArray(data) ? data[0] : data }) };
      }

      case 'update': {
        if (!eventId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'eventId required' }) };
        const res = await sb(`family_events?id=eq.${eventId}&created_by=eq.${userId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            title: evt.title,
            description: evt.description,
            event_date: evt.event_date,
            start_time: evt.start_time,
            end_time: evt.end_time,
            all_day: evt.all_day,
            members: evt.members,
            category: evt.category,
            colour: evt.colour,
            location: evt.location,
            recurring: evt.recurring,
            updated_at: new Date().toISOString()
          })
        });
        const data = await res.json();
        return { statusCode: 200, headers, body: JSON.stringify({ event: Array.isArray(data) ? data[0] : data }) };
      }

      case 'delete': {
        if (!eventId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'eventId required' }) };
        await sb(`family_events?id=eq.${eventId}&created_by=eq.${userId}`, { method: 'DELETE' });
        return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
      }

      default:
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
    }
  } catch (err) {
    console.error('Family events error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
