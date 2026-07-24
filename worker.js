const ALLOWED_ORIGINS = new Set([
  'https://wlstjd88-sys.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
]);

const MODEL = 'gemini-3.6-flash';
const WORKER_VERSION = '1.1.0';
const MAX_PHOTOS = 3;
const MAX_BASE64_CHARS_PER_PHOTO = 7_000_000;
const EBAY_SCOPE = 'https://api.ebay.com/oauth/api_scope';
const EBAY_MARKETPLACE = 'EBAY_US';
let ebayTokenCache = { token: '', expiresAt: 0 };

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (ALLOWED_ORIGINS.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(data, status, origin = '', extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(origin), ...extraHeaders } });
}

function retryAfterSeconds(payload) {
  const details = Array.isArray(payload?.error?.details) ? payload.error.details : [];
  for (const detail of details) {
    const delay = String(detail?.retryDelay || detail?.retry_delay || '');
    const match = /^([0-9]+(?:\.[0-9]+)?)s$/.exec(delay);
    if (match) return Math.max(1, Math.ceil(Number(match[1])));
  }
  const message = String(payload?.error?.message || payload?.message || '');
  const match = /retry\s+in\s+([0-9]+(?:\.[0-9]+)?)s/i.exec(message);
  return match ? Math.max(1, Math.ceil(Number(match[1]))) : 0;
}

function parseDataUrl(value) {
  const match = /^data:(image\/(?:jpeg|png|webp|heic|heif));base64,([A-Za-z0-9+/=]+)$/.exec(String(value || ''));
  if (!match) throw new Error('INVALID_IMAGE');
  if (match[2].length > MAX_BASE64_CHARS_PER_PHOTO) throw new Error('IMAGE_TOO_LARGE');
  return { mimeType: match[1], data: match[2] };
}

function extractText(payload) {
  return (payload?.candidates?.[0]?.content?.parts || []).map((part) => typeof part.text === 'string' ? part.text : '').join('').trim();
}

function clampConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0;
}

function normalizeResult(value) {
  const allowedCategories = new Set(['Shoes', 'Toys', 'Other', 'Unknown']);
  const allowedConditions = new Set(['NEW', 'UNKNOWN']);
  const result = value && typeof value === 'object' ? value : {};
  return {
    brand: String(result.brand || '').trim(),
    productName: String(result.productName || '').trim(),
    category: allowedCategories.has(result.category) ? result.category : 'Unknown',
    color: String(result.color || '').trim(),
    condition: allowedConditions.has(result.condition) ? result.condition : 'UNKNOWN',
    confidence: clampConfidence(result.confidence),
    searchKeyword: String(result.searchKeyword || '').trim(),
    summary: String(result.summary || '').trim(),
  };
}

function basicAuth(clientId, clientSecret) {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

async function getEbayApplicationToken(env) {
  if (!env?.EBAY_CLIENT_ID || !env?.EBAY_CLIENT_SECRET) throw new Error('EBAY_CREDENTIALS_MISSING');
  if (ebayTokenCache.token && Date.now() < ebayTokenCache.expiresAt - 60_000) return ebayTokenCache.token;

  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': basicAuth(env.EBAY_CLIENT_ID, env.EBAY_CLIENT_SECRET),
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: EBAY_SCOPE }).toString(),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    console.error('eBay token error', response.status, JSON.stringify(payload).slice(0, 1200));
    const error = new Error('EBAY_TOKEN_FAILED');
    error.status = response.status || 502;
    error.details = payload;
    throw error;
  }
  const expiresIn = Math.max(60, Number(payload.expires_in) || 7200);
  ebayTokenCache = { token: payload.access_token, expiresAt: Date.now() + expiresIn * 1000 };
  return ebayTokenCache.token;
}

function moneyNumber(value) {
  const number = Number(value?.value ?? value);
  return Number.isFinite(number) ? number : null;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeEbayItem(item) {
  const price = moneyNumber(item?.price);
  const shipping = moneyNumber(item?.shippingOptions?.[0]?.shippingCost);
  return {
    itemId: String(item?.itemId || ''),
    title: String(item?.title || ''),
    price,
    currency: String(item?.price?.currency || 'USD'),
    shipping: shipping ?? 0,
    totalPrice: price === null ? null : price + (shipping ?? 0),
    condition: String(item?.condition || ''),
    imageUrl: String(item?.image?.imageUrl || item?.thumbnailImages?.[0]?.imageUrl || ''),
    itemWebUrl: String(item?.itemWebUrl || ''),
    seller: String(item?.seller?.username || ''),
  };
}

async function searchEbay(request, env, origin) {
  if (!env?.EBAY_CLIENT_ID || !env?.EBAY_CLIENT_SECRET) return json({ error: 'EBAY_CREDENTIALS_MISSING' }, 500, origin);
  const body = await request.json().catch(() => ({}));
  const query = String(body.q || '').trim().slice(0, 200);
  const gtin = String(body.barcode || '').replace(/\D/g, '').slice(0, 14);
  const limit = Math.max(1, Math.min(20, Number(body.limit) || 10));
  if (!query && !gtin) return json({ error: 'EBAY_QUERY_REQUIRED' }, 400, origin);

  try {
    const token = await getEbayApplicationToken(env);
    const params = new URLSearchParams({ limit: String(limit) });
    if (gtin) params.set('gtin', gtin); else params.set('q', query);
    const response = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': EBAY_MARKETPLACE,
        'Accept': 'application/json',
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('eBay search error', response.status, JSON.stringify(payload).slice(0, 1600));
      return json({ error: 'EBAY_SEARCH_FAILED', status: response.status, details: payload?.errors?.[0]?.message || 'eBay search failed' }, response.status, origin);
    }
    const items = (Array.isArray(payload.itemSummaries) ? payload.itemSummaries : []).map(normalizeEbayItem).filter((item) => item.title && item.price !== null);
    const totals = items.filter((item) => item.currency === 'USD').map((item) => item.totalPrice).filter(Number.isFinite);
    return json({
      ok: true,
      query: gtin || query,
      searchedBy: gtin ? 'gtin' : 'keyword',
      marketplace: EBAY_MARKETPLACE,
      total: Number(payload.total) || items.length,
      sampleCount: items.length,
      price: {
        currency: 'USD',
        low: totals.length ? Math.min(...totals) : null,
        median: median(totals),
        high: totals.length ? Math.max(...totals) : null,
      },
      items,
      searchedAt: new Date().toISOString(),
    }, 200, origin);
  } catch (error) {
    console.error('eBay worker error', error?.message || error);
    const status = Number(error?.status) || 500;
    return json({ error: error?.message || 'EBAY_INTERNAL_ERROR', status }, status, origin);
  }
}

async function analyzeWithGemini(request, env, origin) {
  if (!env?.GEMINI_API_KEY) return json({ error: 'GEMINI_API_KEY_MISSING' }, 500, origin);
  try {
    const body = await request.json();
    const photos = Array.isArray(body.photos) ? body.photos.slice(0, MAX_PHOTOS) : [];
    if (!photos.length) return json({ error: 'PHOTO_REQUIRED' }, 400, origin);
    const parts = [{ text: `You are an eBay product sourcing assistant. Analyze only evidence visible in the supplied product photos and optional user input. Do not claim authenticity. If the exact brand or model is uncertain, leave it blank and explain the uncertainty in Korean in summary. Return an English eBay search keyword. Optional input: barcode=${String(body.barcode || '')}, brand=${String(body.brand || '')}, productName=${String(body.productName || '')}.` }];
    for (const photo of photos) {
      const parsed = parseDataUrl(photo);
      parts.push({ inline_data: { mime_type: parsed.mimeType, data: parsed.data } });
    }
    const responseSchema = {
      type: 'OBJECT',
      properties: {
        brand: { type: 'STRING' }, productName: { type: 'STRING' },
        category: { type: 'STRING', enum: ['Shoes', 'Toys', 'Other', 'Unknown'] },
        color: { type: 'STRING' }, condition: { type: 'STRING', enum: ['NEW', 'UNKNOWN'] },
        confidence: { type: 'NUMBER', minimum: 0, maximum: 100 }, searchKeyword: { type: 'STRING' }, summary: { type: 'STRING' },
      },
      required: ['brand', 'productName', 'category', 'color', 'condition', 'confidence', 'searchKeyword', 'summary'],
    };
    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json', responseSchema } }),
    });
    const payload = await geminiResponse.json();
    if (!geminiResponse.ok) {
      const upstreamStatus = Number(geminiResponse.status) || 502;
      const retrySeconds = upstreamStatus === 429 ? retryAfterSeconds(payload) : 0;
      const upstreamMessage = String(payload?.error?.message || 'Gemini request failed').slice(0, 500);
      console.error('Gemini error', upstreamStatus, JSON.stringify(payload).slice(0, 1600));
      const status = [400, 401, 403, 404, 408, 429].includes(upstreamStatus) || upstreamStatus >= 500 ? upstreamStatus : 502;
      return json({ error: 'GEMINI_REQUEST_FAILED', status: upstreamStatus, message: upstreamMessage, retryAfterSeconds: retrySeconds || undefined }, status, origin, retrySeconds ? { 'Retry-After': String(retrySeconds) } : {});
    }
    const text = extractText(payload);
    if (!text) return json({ error: 'EMPTY_GEMINI_RESPONSE' }, 502, origin);
    let parsed;
    try { parsed = JSON.parse(text); } catch { return json({ error: 'INVALID_GEMINI_JSON' }, 502, origin); }
    return json(normalizeResult(parsed), 200, origin);
  } catch (error) {
    console.error('Worker error', error?.message || error);
    const code = error?.message || 'INTERNAL_ERROR';
    return json({ error: code }, ['INVALID_IMAGE', 'IMAGE_TOO_LARGE'].includes(code) ? 400 : 500, origin);
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      if (!ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403, headers: corsHeaders(origin) });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method === 'GET' && url.pathname === '/') {
      return json({ ok: true, service: 'EAS API', version: WORKER_VERSION, model: MODEL, ebay: Boolean(env?.EBAY_CLIENT_ID && env?.EBAY_CLIENT_SECRET) }, 200, origin);
    }
    if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, origin);
    if (!ALLOWED_ORIGINS.has(origin)) return json({ error: 'ORIGIN_NOT_ALLOWED' }, 403, origin);
    if (url.pathname === '/' || url.pathname === '/analyze') return analyzeWithGemini(request, env, origin);
    if (url.pathname === '/ebay/search') return searchEbay(request, env, origin);
    return json({ error: 'NOT_FOUND' }, 404, origin);
  },
};
