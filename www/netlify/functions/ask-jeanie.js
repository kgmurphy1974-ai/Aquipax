// netlify/functions/ask-jeanie.js
// Ask Jeanie — AI financial assistant powered by Claude
// Receives the user's question + their financial context, returns personalised guidance
// Env vars: ANTHROPIC_API_KEY

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Jeanie is not configured.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request.' }) }; }

  const { question, context } = body;
  if (!question?.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Please ask a question.' }) };
  }

  // Build a financial context summary from the user's state
  const ctx = context || {};
  const financialSummary = `
User's financial snapshot:
- Monthly income: £${ctx.income || 0}${ctx.income2 > 0 ? ` + partner £${ctx.income2}` : ''}
- Monthly bills total: £${ctx.tBills || 0}
- Annual costs (smoothed monthly): £${ctx.smoothMonthly || 0}/mo
- Holiday fund: £${ctx.hSave || 0}/mo
- Savings: £${ctx.savingsAmt || 0}/mo
- Safe to spend this month: £${ctx.safe || 0}
- Household size: ${ctx.hhSize || 1} ${ctx.hhSize === 1 ? 'person' : 'people'}
- Upcoming renewals: ${ctx.renewals || 'none noted'}
`.trim();

  const systemPrompt = `You are Jeanie, the friendly and knowledgeable financial assistant built into Aquipax — a UK personal finance app by JeanieIQ.

Your role is to help users understand their finances, answer questions about their Aquipax data, and provide practical, encouraging guidance. You speak in plain English, never jargon. You are warm, direct, and honest.

IMPORTANT RULES:
1. You are NOT a regulated financial adviser. Always add a brief disclaimer for significant financial decisions.
2. Base your answers on the user's actual financial data provided below.
3. Be specific — use their actual numbers, not generic advice.
4. Keep answers concise — 3-5 sentences max unless a detailed breakdown is genuinely needed.
5. Be encouraging but honest. If the numbers don't add up, say so kindly.
6. Never recommend specific investment products, insurance providers, or financial products.
7. If asked about something outside personal finance (e.g. medical, legal), politely redirect.

${financialSummary}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 350,
        system: systemPrompt,
        messages: [
          { role: 'user', content: question.trim() }
        ]
      })
    });

    const data = await res.json();
    if (!res.ok) {
      console.error('Claude error:', JSON.stringify(data));
      return { statusCode: 502, body: JSON.stringify({ error: 'Jeanie is having a moment — please try again.' }) };
    }

    const answer = data.content?.[0]?.text?.trim();
    if (!answer) {
      return { statusCode: 500, body: JSON.stringify({ error: 'No response from Jeanie.' }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ answer })
    };

  } catch (err) {
    console.error('Ask Jeanie error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong. Please try again.' }) };
  }
};