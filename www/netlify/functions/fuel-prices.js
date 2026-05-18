// netlify/functions/fuel-prices.js
// Uses the UK Government Fuel Finder API (OAuth) for full UK coverage
// All petrol stations legally required to participate — ~8,000+ sites

const FUEL_FINDER_BASE = 'https://api.fuel-finder.service.gov.uk';

// Cache the OAuth token in memory (persists across warm invocations)
let _cachedToken = null;
let _tokenExpiry = 0;

async function getAccessToken() {
  const now = Date.now();
  if (_cachedToken && now < _tokenExpiry - 30000) return _cachedToken;

  const clientId = process.env.FUEL_FINDER_CLIENT_ID;
  const clientSecret = process.env.FUEL_FINDER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('FUEL_FINDER_CLIENT_ID and FUEL_FINDER_CLIENT_SECRET not set');
  }

  const res = await fetch(`${FUEL_FINDER_BASE}/api/v1/oauth/generate_access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  _cachedToken = data.access_token;
  // Tokens typically valid for 3600s; cache for 50 minutes to be safe
  _tokenExpiry = now + (data.expires_in ? data.expires_in * 1000 : 3000000);
  return _cachedToken;
}

// Haversine distance in miles
function distanceMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=1800'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const params = event.queryStringParameters || {};
  const userLat = parseFloat(params.lat);
  const userLng = parseFloat(params.lng);
  const fuelType = (params.type || 'E10').toUpperCase();
  const radiusMiles = parseFloat(params.radius) || 5;
  const maxResults = parseInt(params.limit) || 20;

  if (isNaN(userLat) || isNaN(userLng)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'lat and lng parameters required' })
    };
  }

  try {
    const token = await getAccessToken();

    // Map our fuel type codes to the API's format
    const fuelTypeMap = {
      'E10': 'E10_STANDARD',
      'B7': 'B7_STANDARD',
      'E5': 'E5_PREMIUM_UNLEADED',
      'SDV': 'B7_PREMIUM'
    };
    const apiFuelType = fuelTypeMap[fuelType] || 'E10_STANDARD';

    // Fetch stations and prices in parallel
    const [stationsRes, pricesRes] = await Promise.all([
      fetch(`${FUEL_FINDER_BASE}/api/v1/pfs?latitude=${userLat}&longitude=${userLng}&radius=${Math.ceil(radiusMiles * 1.60934)}&limit=200`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(12000)
      }),
      fetch(`${FUEL_FINDER_BASE}/api/v1/pfs/fuel-prices?latitude=${userLat}&longitude=${userLng}&radius=${Math.ceil(radiusMiles * 1.60934)}&fuel_type=${apiFuelType}&limit=200`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(12000)
      })
    ]);

    let stationsData = null;
    let pricesData = null;

    if (stationsRes.ok) stationsData = await stationsRes.json();
    if (pricesRes.ok) pricesData = await pricesRes.json();

    // Build a map of site_id -> station details
    const stationMap = {};
    const stationsList = stationsData?.data || stationsData?.stations || stationsData?.results || [];
    for (const s of stationsList) {
      const id = s.site_id || s.id || s.pfs_id;
      if (id) stationMap[id] = s;
    }

    // Build results from prices data
    const pricesList = pricesData?.data || pricesData?.stations || pricesData?.results || [];
    let results = [];

    for (const p of pricesList) {
      const id = p.site_id || p.id || p.pfs_id;
      const station = stationMap[id] || p;

      const lat = parseFloat(station.latitude || station.lat || p.latitude || p.lat);
      const lng = parseFloat(station.longitude || station.lng || station.lon || p.longitude || p.lng || p.lon);
      if (isNaN(lat) || isNaN(lng)) continue;

      // Get price — try multiple field names
      const priceRaw = p.price || p.prices?.[fuelType] || p.prices?.[apiFuelType] ||
                       p[fuelType.toLowerCase()] || p[apiFuelType.toLowerCase()];
      if (!priceRaw) continue;

      // Convert to pence if needed (API may return £/L as decimal)
      const price = priceRaw > 10 ? Math.round(priceRaw * 10) / 10 : Math.round(priceRaw * 1000) / 10;

      const dist = distanceMiles(userLat, userLng, lat, lng);
      if (dist > radiusMiles) continue;

      results.push({
        id,
        brand: station.brand || station.operator || station.name || p.brand || 'Station',
        name: station.name || station.brand || p.name || '',
        address: [station.address, station.street, station.town].filter(Boolean).join(', ') ||
                 station.address_line_1 || p.address || '',
        postcode: station.postcode || p.postcode || '',
        lat, lng,
        price,
        fuelType,
        distanceMiles: Math.round(dist * 10) / 10,
        lastUpdated: p.last_updated || p.updated_at || null
      });
    }

    // If the API didn't return combined data, fall back to retailer feeds
    if (results.length === 0) {
      return await fallbackToRetailerFeeds(userLat, userLng, fuelType, maxResults, headers);
    }

    // Sort by price, then distance
    results.sort((a, b) => a.price - b.price || a.distanceMiles - b.distanceMiles);

    // Deduplicate
    const seen = new Set();
    results = results.filter(s => {
      const key = `${s.postcode || s.id}-${s.price}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        stations: results.slice(0, maxResults),
        total: results.length,
        fuelType,
        source: 'fuel-finder-gov',
        timestamp: new Date().toISOString()
      })
    };

  } catch (err) {
    console.error('Fuel Finder API error:', err.message);
    // Fall back to retailer feeds if OAuth fails
    return await fallbackToRetailerFeeds(userLat, userLng, fuelType, maxResults, headers);
  }
};

// Fallback: use individual retailer open data feeds
async function fallbackToRetailerFeeds(userLat, userLng, fuelType, maxResults, headers) {
  const feeds = [
    { url: 'https://storelocator.asda.com/fuel_prices_data.json', name: 'Asda' },
    { url: 'https://api.sainsburys.co.uk/v1/exports/latest/fuel_prices_data.json', name: "Sainsbury's" },
    { url: 'https://www.morrisons.com/fuel-prices/fuel.json', name: 'Morrisons' },
    { url: 'https://applegreenstores.com/fuel-prices/data.json', name: 'Applegreen' },
    { url: 'https://coop.co.uk/fuel-prices/data.json', name: 'Co-op' },
    { url: 'https://www.harvestenergy.co.uk/fuel-prices/data.json', name: 'Harvest Energy' },
  ];

  function dist(lat1, lng1, lat2, lng2) {
    const R = 3958.8;
    const dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
    return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
  }

  let all = [];
  const fetches = await Promise.allSettled(feeds.map(f =>
    fetch(f.url, { headers: { 'User-Agent': 'Aquipax/1.0' }, signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() : null)
      .then(d => ({ data: d, name: f.name }))
      .catch(() => ({ data: null, name: f.name }))
  ));

  for (const r of fetches) {
    if (r.status !== 'fulfilled' || !r.value.data) continue;
    const stations = r.value.data.stations || [];
    for (const s of stations) {
      const lat = s.location?.latitude || s.lat;
      const lng = s.location?.longitude || s.lng;
      if (!lat || !lng) continue;
      const price = s.prices?.[fuelType];
      if (!price) continue;
      const d = dist(userLat, userLng, lat, lng);
      if (d > 10) continue;
      all.push({ id: s.site_id, brand: s.brand || r.value.name, address: s.address || '', postcode: s.postcode || '', lat, lng, price, fuelType, distanceMiles: Math.round(d*10)/10 });
    }
  }

  all.sort((a, b) => a.price - b.price || a.distanceMiles - b.distanceMiles);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ stations: all.slice(0, maxResults), total: all.length, fuelType, source: 'retailer-feeds', timestamp: new Date().toISOString() })
  };
}
