// netlify/functions/household.js
// Manages family household creation, joining, and member management
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

  // Helper: call Supabase REST API
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
    if (!res.ok) throw new Error(`Supabase ${method} ${path}: ${text}`);
    return text ? JSON.parse(text) : null;
  };

  try {
    const body = JSON.parse(event.body || '{}');
    const { action, userId, householdCode, memberName } = body;

    if (!userId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'userId required' }) };
    }

    // ── CREATE HOUSEHOLD ──
    if (action === 'create') {
      // Generate a unique 6-character household code
      const code = Math.random().toString(36).substring(2, 8).toUpperCase();

      // Create the household
      const [household] = await sb('households', 'POST', {
        code,
        owner_id: userId,
        created_at: new Date().toISOString()
      });

      // Add the owner as the first member
      await sb('household_members', 'POST', {
        household_id: household.id,
        user_id: userId,
        name: memberName || 'You',
        role: 'owner',
        joined_at: new Date().toISOString()
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, householdId: household.id, code })
      };
    }

    // ── JOIN HOUSEHOLD ──
    if (action === 'join') {
      if (!householdCode) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'householdCode required' }) };
      }

      // Find the household by code
      const households = await sb(`households?code=eq.${householdCode.toUpperCase()}&select=id,code,owner_id`);
      if (!households || households.length === 0) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Household not found. Check the code and try again.' }) };
      }

      const household = households[0];

      // Check member count (max 4)
      const members = await sb(`household_members?household_id=eq.${household.id}&select=id,user_id`);
      if (members && members.length >= 4) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'This household is full (maximum 4 members).' }) };
      }

      // Check if already a member
      const existing = members ? members.find(m => m.user_id === userId) : null;
      if (existing) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true, householdId: household.id, code: household.code, alreadyMember: true })
        };
      }

      // Add as member
      await sb('household_members', 'POST', {
        household_id: household.id,
        user_id: userId,
        name: memberName || 'Member',
        role: 'member',
        joined_at: new Date().toISOString()
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, householdId: household.id, code: household.code })
      };
    }

    // ── GET HOUSEHOLD DATA ──
    if (action === 'get') {
      // Find user's household
      const memberships = await sb(`household_members?user_id=eq.${userId}&select=household_id,role,name`);
      if (!memberships || memberships.length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ household: null }) };
      }

      const membership = memberships[0];
      const households = await sb(`households?id=eq.${membership.household_id}&select=id,code,owner_id`);
      if (!households || households.length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ household: null }) };
      }

      const household = households[0];
      const allMembers = await sb(`household_members?household_id=eq.${household.id}&select=user_id,name,role,joined_at`);

      // Get shared financial data (from owner's user_data)
      const ownerData = await sb(`user_data?user_id=eq.${household.owner_id}&select=data`);
      const sharedData = ownerData?.[0]?.data || null;

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          household: {
            id: household.id,
            code: household.code,
            isOwner: household.owner_id === userId,
            myRole: membership.role,
            myName: membership.name,
            members: allMembers || []
          },
          sharedData
        })
      };
    }

    // ── LEAVE HOUSEHOLD ──
    if (action === 'leave') {
      const memberships = await sb(`household_members?user_id=eq.${userId}&select=household_id,role`);
      if (!memberships || memberships.length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
      }

      const { household_id, role } = memberships[0];

      if (role === 'owner') {
        // Owner leaving — delete the whole household
        await sb(`household_members?household_id=eq.${household_id}`, 'DELETE');
        await sb(`households?id=eq.${household_id}`, 'DELETE');
      } else {
        // Member leaving — just remove themselves
        await sb(`household_members?user_id=eq.${userId}&household_id=eq.${household_id}`, 'DELETE');
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    console.error('Household error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Household operation failed: ' + err.message })
    };
  }
};
