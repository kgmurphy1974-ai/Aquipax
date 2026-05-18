// netlify/functions/basket-compare.js
// Compares a shopping basket across UK supermarkets using Apify scrapers
// Returns total basket cost at each supermarket with item-level breakdown

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
const APIFY_BASE = 'https://api.apify.com/v2';

// Apify actor IDs for each supermarket
const SCRAPERS = {
  tesco: 'illehius/tesco-scraper',
  asda: 'illehius/asda-scraper',
  sainsburys: 'illehius/sainsburys-scraper',
  morrisons: 'illehius/morrisons-scraper',
};

async function searchSupermarket(actorId, query, token) {
  try {
    // Run the actor
    const runRes = await fetch(`${APIFY_BASE}/acts/${actorId}/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        queries: [query],
        maxResultsPerQuery: 3
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (!runRes.ok) return null;
    const runData = await runRes.json();
    const runId = runData.data?.id;
    if (!runId) return null;

    // Wait for completion (poll up to 25 seconds)
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await fetch(`${APIFY_BASE}/actor-runs/${runId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(8000)
      });
      if (!statusRes.ok) continue;
      const statusData = await statusRes.json();
      if (statusData.data?.status === 'SUCCEEDED') {
        // Get results
        const resultsRes = await fetch(`${APIFY_BASE}/actor-runs/${runId}/dataset/items?limit=3`, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: AbortSignal.timeout(8000)
        });
        if (!resultsRes.ok) return null;
        const items = await resultsRes.json();
        if (items.length > 0) {
          const item = items[0];
          return {
            name: item.name || item.title || query,
            price: item.price || item.currentPrice || null,
            onOffer: item.onOffer || false,
            offerDescription: item.offerDescription || item.promotionDescription || '',
            unitPrice: item.unitPrice || null,
            url: item.productUrl || item.url || ''
          };
        }
        return null;
      }
      if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(statusData.data?.status)) return null;
    }
    return null;
  } catch (e) {
    return null;
  }
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=1800' // 30 min cache
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (!APIFY_TOKEN) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'APIFY_API_TOKEN not configured' })
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { items = [] } = body; // Array of ingredient/product names

    if (!items.length) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'No items provided' })
      };
    }

    // Limit to 15 items to control API costs
    const searchItems = items.slice(0, 15);
    const supermarkets = Object.keys(SCRAPERS);

    // Search each item at each supermarket in parallel
    const results = {};
    supermarkets.forEach(s => { results[s] = { items: {}, total: 0, found: 0 }; });

    // Process items in batches to avoid overwhelming Apify
    const batchSize = 3;
    for (let i = 0; i < searchItems.length; i += batchSize) {
      const batch = searchItems.slice(i, i + batchSize);

      await Promise.all(batch.map(async item => {
        // Search all supermarkets for this item in parallel
        const supermarketResults = await Promise.all(
          supermarkets.map(async supermarket => {
            const result = await searchSupermarket(SCRAPERS[supermarket], item, APIFY_TOKEN);
            return { supermarket, result };
          })
        );

        supermarketResults.forEach(({ supermarket, result }) => {
          if (result && result.price) {
            results[supermarket].items[item] = result;
            results[supermarket].total += result.price;
            results[supermarket].found++;
          } else {
            results[supermarket].items[item] = null;
          }
        });
      }));
    }

    // Build comparison summary
    const comparison = supermarkets.map(s => ({
      supermarket: s.charAt(0).toUpperCase() + s.slice(1),
      total: Math.round(results[s].total * 100) / 100,
      found: results[s].found,
      outOf: searchItems.length,
      items: results[s].items
    })).sort((a, b) => {
      // Sort by total, but put stores with fewer found items last
      if (a.found < searchItems.length * 0.5) return 1;
      if (b.found < searchItems.length * 0.5) return -1;
      return a.total - b.total;
    });

    // Find cheapest store
    const validStores = comparison.filter(s => s.found >= searchItems.length * 0.5);
    const cheapest = validStores[0];
    const mostExpensive = validStores[validStores.length - 1];
    const potentialSaving = cheapest && mostExpensive
      ? Math.round((mostExpensive.total - cheapest.total) * 100) / 100
      : 0;

    // Item-level cheapest
    const itemCheapest = {};
    searchItems.forEach(item => {
      let cheapestStore = null;
      let cheapestPrice = Infinity;
      supermarkets.forEach(s => {
        const r = results[s].items[item];
        if (r && r.price < cheapestPrice) {
          cheapestPrice = r.price;
          cheapestStore = s;
        }
      });
      if (cheapestStore) {
        itemCheapest[item] = { store: cheapestStore, price: cheapestPrice };
      }
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        comparison,
        cheapest: cheapest?.supermarket || null,
        potentialSaving,
        itemCheapest,
        itemsSearched: searchItems.length,
        generatedAt: new Date().toISOString()
      })
    };

  } catch (err) {
    console.error('Basket compare error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to compare prices. Please try again.' })
    };
  }
};
