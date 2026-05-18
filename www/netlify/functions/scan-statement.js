// netlify/functions/scan-statement.js
// Analyses a bank statement: extracts recurring bills AND categorised actual spending
// Stores results in Supabase for pattern tracking
// Env vars: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY

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

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' })
    };
  }

  try {
     const body = JSON.parse(event.body || '{}');
    const { imageBase64, mediaType, statementText, pdfImages } = body;

    if (!imageBase64 && !statementText && !pdfImages) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No statement data provided' }) };
    }

    const systemPrompt = `You are a UK bank statement analyser. Analyse ALL transactions in the statement.

Return ONLY valid JSON with this EXACT structure:
{
  "bills": [
    {"label": "Netflix", "amount": 15.99, "category": "Entertainment", "frequency": "monthly", "confidence": "high"}
  ],
  "spending": [
    {"category": "Food & Groceries", "total": 342.50, "transactions": 12, "examples": ["Tesco £89.40", "Sainsbury's £76.20"]}
  ],
  "income": [
    {"label": "Salary", "amount": 2800.00, "frequency": "monthly"}
  ],
  "summary": "Statement covers [period]. Found X recurring bills totalling £Y/month. Total spending: £Z.",
  "period": "e.g. April 2026 or 01/04/2026-30/04/2026"
}

BILLS rules:
- ONLY recurring/regular payments: direct debits, standing orders, subscriptions
- Do NOT include one-off transactions, ATM withdrawals, transfers between own accounts, or salary
- Convert weekly to monthly (x4.33), annual to monthly (÷12)
- Round to 2 decimal places
- category must be: Housing, Utilities, Transport, Food, Entertainment, Insurance, Savings, Family, Health, Other

SPENDING rules:
- Group ALL debit transactions (excluding bills already listed) by category
- Categories: Food & Groceries, Eating Out & Takeaways, Petrol & Transport, Shopping & Clothing, Entertainment & Leisure, Health & Pharmacy, Kids & Family, Home & Garden, Other
- Sum total spent per category, count transactions, list top 3 examples with amounts

INCOME rules:
- List salary, benefits, tax credits, or regular income credits only

CRITICAL: Your response must contain ONLY the JSON object. No explanation, no preamble, no markdown, no code fences. Start your response with { and end with }. If you cannot extract data, still return the JSON structure with empty arrays.`;

    let messages;

    if (pdfImages && pdfImages.length > 0) {
      // PDF rendered as images - send all pages to Claude Vision
      const content = pdfImages.map(img => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: img }
      }));
      content.push({
        type: 'text',
        text: 'This is a UK bank statement (likely Lloyds Bank) rendered as images. Analyse ALL transactions across all pages and return the JSON as instructed. Include ALL transactions — both recurring bills and categorised spending. Start your response with { and end with }.'
      });
      messages = [{ role: 'user', content }];
    } else if (imageBase64) {
      const imgMediaType = mediaType || 'image/jpeg';
      
      if (imgMediaType === 'application/pdf') {
        // PDF - use Anthropic's native PDF support (beta)
        messages = [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: imageBase64 }
            },
            {
              type: 'text',
              text: 'This is a UK Lloyds Bank statement PDF. Analyse ALL transactions and return the JSON as instructed. Include ALL transactions — both recurring bills and categorised spending. Start your response with { and end with }.'
            }
          ]
        }];
      } else {
        // Regular image
        messages = [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: imgMediaType, data: imageBase64 }
            },
            {
              type: 'text',
              text: 'Analyse this bank statement and return the JSON as instructed. Include ALL transactions — both recurring bills and categorised spending.'
            }
          ]
        }];
      }
    } else {
      // Text-based (CSV, pasted text)
      messages = [{
        role: 'user',
        content: `Analyse this UK bank statement data (may be from Lloyds, Barclays, HSBC, NatWest, Santander or similar). Return ONLY the JSON object as instructed. Include ALL transactions:\n\n${statementText.slice(0, 15000)}`
      }];
    }

    const aiHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'pdfs-2024-09-25'  // Enable PDF support
    };

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: aiHeaders,
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 4000,
        system: systemPrompt,
        messages
      })
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error('Anthropic API error:', errText);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'AI processing failed', details: errText })
      };
    }

    const aiData = await aiRes.json();
    const text = aiData.content?.[0]?.text || '';
    
    console.log('Claude response length:', text.length);
    console.log('Claude response preview:', text.slice(0, 500));

    // Try multiple JSON extraction strategies
    let result = null;
    
    // Strategy 1: Find outermost JSON object
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { result = JSON.parse(jsonMatch[0]); } catch(e) {
        // Strategy 2: Find JSON between code fences
        const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) {
          try { result = JSON.parse(fenceMatch[1].trim()); } catch(e2) {}
        }
      }
    }
    
    // Strategy 3: If still no result, try to extract partial data
    if (!result) {
      // Try to at least get bills array
      const billsMatch = text.match(/"bills"\s*:\s*(\[[\s\S]*?\])/);
      const spendingMatch = text.match(/"spending"\s*:\s*(\[[\s\S]*?\])/);
      if (billsMatch || spendingMatch) {
        result = {
          bills: billsMatch ? JSON.parse(billsMatch[1]) : [],
          spending: spendingMatch ? JSON.parse(spendingMatch[1]) : [],
          income: [],
          summary: 'Partial extraction — some data recovered.',
          period: null
        };
      }
    }
    
    if (!result) {
      console.error('Parse failed. Full response:', text);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          bills: [],
          spending: [],
          income: [],
          summary: 'Could not parse the statement. Try pasting the transaction text directly (Option 3) for best results.',
          error: 'parse_failed'
        })
      };
    }

    // Clean bills
    result.bills = (result.bills || [])
      .filter(b => b.label && b.amount > 0)
      .map(b => ({
        label: String(b.label).trim(),
        amount: Math.round(Number(b.amount) * 100) / 100,
        category: b.category || 'Other',
        frequency: b.frequency || 'monthly',
        confidence: b.confidence || 'medium'
      }));

    // Clean spending
    result.spending = (result.spending || [])
      .filter(s => s.category && s.total > 0)
      .map(s => ({
        category: String(s.category).trim(),
        total: Math.round(Number(s.total) * 100) / 100,
        transactions: Number(s.transactions) || 0,
        examples: (s.examples || []).slice(0, 3)
      }));

    // Clean income
    result.income = (result.income || [])
      .filter(i => i.label && i.amount > 0)
      .map(i => ({
        label: String(i.label).trim(),
        amount: Math.round(Number(i.amount) * 100) / 100,
        frequency: i.frequency || 'monthly'
      }));

    // Save to Supabase for pattern tracking
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    const userId = body.userId;
    if (supabaseUrl && supabaseKey && userId && result.spending.length > 0) {
      try {
        await fetch(`${supabaseUrl}/rest/v1/spending_history`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            user_id: userId,
            period: result.period || new Date().toISOString().slice(0, 7),
            spending: result.spending,
            bills: result.bills,
            income: result.income,
            summary: result.summary,
            scanned_at: new Date().toISOString()
          })
        });
      } catch (saveErr) {
        console.error('Failed to save spending history:', saveErr);
        // Don't fail the request if save fails
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result)
    };

  } catch (err) {
    console.error('Statement scan error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to process statement: ' + err.message })
    };
  }
};
