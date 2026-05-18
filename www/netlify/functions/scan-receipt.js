// netlify/functions/scan-receipt.js
// Three-layer receipt intelligence:
//   1. Claude AI       — extract items, categories, totals
//   2. Apify scrapers  — LIVE UK supermarket prices + current offers
//   3. Open Food Facts — nutrition data (free, no key)
//
// Env vars required:
//   ANTHROPIC_API_KEY  — Anthropic Claude API key
//   APIFY_API_TOKEN    — Apify API token (apify.com)
//   (RAPIDAPI_KEY no longer needed)

const APIFY_BASE = 'https://api.apify.com/v2';

// Apify actor IDs for each supermarket
const ACTORS = {
  tesco:       'illehius/tesco-scraper',
  asda:        'illehius/asda-scraper',
  sainsburys:  'illehius/sainsburys-scraper',
  morrisons:   'illehius/morrisons-scraper',
  waitrose:    'illehius/waitrose-scraper',
};

// Run an Apify actor synchronously and return results
async function runApifyActor(actorId, input, apifyToken) {
  const url = `${APIFY_BASE}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items` +
    `?token=${apifyToken}&timeout=30&memory=256`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => String(res.status));
    throw new Error(`Apify ${actorId} error ${res.status}: ${err.substring(0, 200)}`);
  }
  return res.json(); // returns array of dataset items
}

// Extract price and offer info from an Apify result item
// All illehius scrapers use the same schema:
// { store, name, brand, price, unitPrice, unitPriceMeasure, unitSize, onOffer, offerDescription, productUrl }
function extractPrice(item, storeName) {
  if (!item) return null;

  const price = typeof item.price === 'number' ? item.price : parseFloat(item.price);
  if (!price || isNaN(price) || price <= 0) return null;

  const result = {
    name: storeName,
    price,
    offers: [],
    unitPrice: item.unitPrice || null,
    unitPriceMeasure: item.unitPriceMeasure || null,
  };

  // onOffer + offerDescription (standard across all illehius scrapers)
  if (item.onOffer && item.offerDescription) {
    const desc = item.offerDescription.trim();
    result.offers.push(desc);
    // Extract Clubcard price from description e.g. "Clubcard Price: £1.10"
    const clubMatch = desc.match(/£([\d.]+)/);
    if (clubMatch && desc.toLowerCase().includes('clubcard')) {
      const cp = parseFloat(clubMatch[1]);
      if (!isNaN(cp) && cp < price) result.clubcardPrice = cp;
    }
  } else if (item.onOffer) {
    result.offers.push('On offer');
  }

  return result;
}

// Query a single supermarket via Apify and return price + offers
async function queryStore(storeName, actorId, productName, apifyToken) {
  try {
    // All illehius scrapers use 'queries' array + 'maxResultsPerQuery'
    const input = { queries: [productName], maxResultsPerQuery: 3 };
    const items = await runApifyActor(actorId, input, apifyToken);
    if (!Array.isArray(items) || items.length === 0) return null;
    // First result is the best match for the search query
    return extractPrice(items[0], storeName);
  } catch (e) {
    console.log(`[${storeName}] lookup failed: ${e.message}`);
    return null;
  }
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const apifyToken   = process.env.APIFY_API_TOKEN;

  if (!anthropicKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Receipt scanning not configured.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body.' }) }; }

  const { image, mediaType, textContent } = body;
  if (!image && !textContent) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No receipt data provided.' }) };
  }

  // ── LAYER 1: Claude AI extraction ────────────────────────────────────────
  const systemPrompt = `You are a receipt scanner. Extract all purchased items and return ONLY valid JSON with no markdown fences.
Schema:
{
  "retailer": "string",
  "date": "D Mon YYYY",
  "time": "HH:MM",
  "total": number,
  "items": [{"name":"string","qty":number,"price":number,"category":"Groceries|Bakery|Dairy|Meat & Fish|Produce|Drinks|Household|Food & Drink|Snacks|Alcohol|Other"}],
  "comparisonItems": ["exact branded product name 1","exact branded product name 2","exact branded product name 3"],
  "nutritionItems": ["product name 1","product name 2","product name 3","product name 4","product name 5"]
}
comparisonItems: 3-5 branded products sold at multiple UK supermarkets (e.g. "Warburtons White 800g", "Cathedral City 400g"). Skip loose produce, restaurant meals, own-brand items.
nutritionItems: up to 8 food/drink product names suitable for nutrition lookup.
If unreadable return: {"error":"unreadable"}`;

  let messages;
  if (textContent) {
    messages = [{ role: 'user', content: `Extract this receipt:\n\n${textContent.substring(0, 8000)}` }];
  } else if (mediaType === 'application/pdf') {
    messages = [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: image } },
      { type: 'text', text: 'Extract all purchased items from this receipt.' }
    ]}];
  } else {
    messages = [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
      { type: 'text', text: 'Extract this receipt.' }
    ]}];
  }

  let extracted;
  try {
    const aiHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01'
    };
    if (mediaType === 'application/pdf') aiHeaders['anthropic-beta'] = 'pdfs-2024-09-25';

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: aiHeaders,
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 4000, system: systemPrompt, messages })
    });

    const aiData = await aiRes.json();
    if (!aiRes.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: 'AI service error: ' + (aiData.error?.message || aiRes.status) }) };
    }

    const rawText = (aiData.content || []).map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
    extracted = JSON.parse(rawText);
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not read receipt. Please try a clearer photo.' }) };
  }

  if (extracted.error) {
    return { statusCode: 200, body: JSON.stringify({ error: 'unreadable' }) };
  }

  // ── LAYER 2: Live supermarket prices via Apify ────────────────────────────
  const comparisons = [];

  if (apifyToken && extracted.comparisonItems?.length) {
    for (const itemName of extracted.comparisonItems.slice(0, 4)) {
      try {
        // Query all stores in parallel
        const storeResults = await Promise.allSettled([
          queryStore('Tesco',       ACTORS.tesco,      itemName, apifyToken),
          queryStore('ASDA',        ACTORS.asda,       itemName, apifyToken),
          queryStore("Sainsbury's", ACTORS.sainsburys, itemName, apifyToken),
          queryStore('Morrisons',   ACTORS.morrisons,  itemName, apifyToken),
          queryStore('Waitrose',    ACTORS.waitrose,   itemName, apifyToken),
        ]);

        const retailers = storeResults
          .filter(r => r.status === 'fulfilled' && r.value !== null)
          .map(r => r.value)
          .sort((a, b) => {
            // Sort by effective price (use Clubcard price if available)
            const aP = a.clubcardPrice ?? a.price;
            const bP = b.clubcardPrice ?? b.price;
            return aP - bP;
          });

        if (retailers.length >= 2) {
          // Find the receipt price for this item
          const receiptItem = extracted.items.find(i =>
            i.name.toLowerCase().includes(itemName.toLowerCase().split(' ')[0]) ||
            itemName.toLowerCase().includes(i.name.toLowerCase().split(' ')[0])
          );
          const yourPrice = receiptItem ? Number(receiptItem.price) : retailers[0].price;

          comparisons.push({
            name: itemName,
            yourPrice,
            retailers,
            liveData: true,
            hasOffers: retailers.some(r => r.offers?.length > 0),
          });
        }
      } catch(e) {
        console.log(`Comparison failed for "${itemName}": ${e.message}`);
      }
    }
  }

  // ── LAYER 3: Nutrition data (Open Food Facts — free) ─────────────────────
  let nutrition = null;
  if (extracted.nutritionItems?.length) {
    let totalCalories = 0, totalProtein = 0, totalFat = 0, totalCarbs = 0, totalSugar = 0;
    let itemsFound = 0;
    const nutritionDetails = [];

    for (const itemName of extracted.nutritionItems.slice(0, 8)) {
      try {
        const searchUrl = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(itemName)}&search_simple=1&action=process&json=1&page_size=1&fields=product_name,nutriments,nutriscore_grade,nova_group`;
        const res = await fetch(searchUrl, {
          headers: { 'User-Agent': 'Aquipax/2.0 (hello@jeanieiq.com)' }
        });
        if (!res.ok) continue;
        const data = await res.json();
        const product = data.products?.[0];
        if (!product?.nutriments) continue;

        const n = product.nutriments;
        const cal = n['energy-kcal_100g'] || n['energy-kcal'] || 0;
        const prot = n['proteins_100g'] || 0;
        const fat = n['fat_100g'] || 0;
        const carb = n['carbohydrates_100g'] || 0;
        const sugar = n['sugars_100g'] || 0;

        if (cal > 0) {
          totalCalories += cal; totalProtein += prot; totalFat += fat;
          totalCarbs += carb; totalSugar += sugar; itemsFound++;
          nutritionDetails.push({
            name: itemName,
            calories: Math.round(cal),
            protein: Math.round(prot * 10) / 10,
            fat: Math.round(fat * 10) / 10,
            carbs: Math.round(carb * 10) / 10,
            nutriScore: product.nutriscore_grade?.toUpperCase() || null,
            novaGroup: product.nova_group || null,
          });
        }
      } catch(e) {
        console.log(`Nutrition lookup failed for "${itemName}": ${e.message}`);
      }
    }

    if (itemsFound > 0) {
      const scores = nutritionDetails.map(i => i.nutriScore).filter(Boolean);
      const healthy = scores.filter(s => ['A','B'].includes(s)).length;
      const processed = nutritionDetails.filter(i => i.novaGroup >= 4).length;
      nutrition = {
        itemsAnalysed: itemsFound,
        totalCaloriesPer100g: Math.round(totalCalories / itemsFound),
        avgProtein: Math.round(totalProtein / itemsFound * 10) / 10,
        avgFat: Math.round(totalFat / itemsFound * 10) / 10,
        avgCarbs: Math.round(totalCarbs / itemsFound * 10) / 10,
        avgSugar: Math.round(totalSugar / itemsFound * 10) / 10,
        healthyItemsPct: scores.length > 0 ? Math.round((healthy / scores.length) * 100) : null,
        ultraProcessedCount: processed,
        items: nutritionDetails,
      };
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      retailer:     extracted.retailer || 'Unknown',
      date:         extracted.date || '',
      time:         extracted.time || '',
      total:        extracted.total || 0,
      items:        extracted.items || [],
      comparisons,
      nutrition,
      livePrices:   comparisons.length > 0,
      liveNutrition: nutrition !== null,
    }),
  };
};
