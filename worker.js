const ALLOWED_ORIGINS = new Set([
  'https://wlstjd88-sys.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
]);

const MODEL = 'gemini-3.6-flash';
const WORKER_VERSION = '1.0.4';
const MAX_PHOTOS = 3;
const MAX_BASE64_CHARS_PER_PHOTO = 7_000_000;

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
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(origin), ...extraHeaders },
  });
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
  return (payload?.candidates?.[0]?.content?.parts || [])
    .map((part) => typeof part.text === 'string' ? part.text : '')
    .join('')
    .trim();
}

function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      if (!ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403, headers: corsHeaders(origin) });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method === 'GET') {
      return json({ ok: true, service: 'EAS Gemini API', version: WORKER_VERSION, model: MODEL }, 200, origin);
    }

    if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, origin);
    if (url.pathname !== '/' && url.pathname !== '/analyze') return json({ error: 'NOT_FOUND' }, 404, origin);
    if (!ALLOWED_ORIGINS.has(origin)) return json({ error: 'ORIGIN_NOT_ALLOWED' }, 403, origin);
    if (!env?.GEMINI_API_KEY) return json({ error: 'GEMINI_API_KEY_MISSING' }, 500, origin);

    try {
      const body = await request.json();
      const photos = Array.isArray(body.photos) ? body.photos.slice(0, MAX_PHOTOS) : [];
      if (!photos.length) return json({ error: 'PHOTO_REQUIRED' }, 400, origin);

      const parts = [{
        text: `You are an eBay product sourcing assistant. Analyze only evidence visible in the supplied product photos and optional user input. Do not claim authenticity. If the exact brand or model is uncertain, leave it blank and explain the uncertainty in Korean in summary. Return an English eBay search keyword. Optional input: barcode=${String(body.barcode || '')}, brand=${String(body.brand || '')}, productName=${String(body.productName || '')}.`,
      }];

      for (const photo of photos) {
        const parsed = parseDataUrl(photo);
        parts.push({ inline_data: { mime_type: parsed.mimeType, data: parsed.data } });
      }

      const responseSchema = {
        type: 'OBJECT',
        properties: {
          brand: { type: 'STRING' },
          productName: { type: 'STRING' },
          category: { type: 'STRING', enum: ['Shoes', 'Toys', 'Other', 'Unknown'] },
          color: { type: 'STRING' },
          condition: { type: 'STRING', enum: ['NEW', 'UNKNOWN'] },
          confidence: { type: 'NUMBER', minimum: 0, maximum: 100 },
          searchKeyword: { type: 'STRING' },
          summary: { type: 'STRING' },
        },
        required: ['brand', 'productName', 'category', 'color', 'condition', 'confidence', 'searchKeyword', 'summary'],
      };

      const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseSchema,
          },
        }),
      });

      const payload = await geminiResponse.json();
      if (!geminiResponse.ok) {
        const upstreamStatus = Number(geminiResponse.status) || 502;
        const retrySeconds = upstreamStatus === 429 ? retryAfterSeconds(payload) : 0;
        const upstreamMessage = String(payload?.error?.message || 'Gemini request failed').slice(0, 500);
        console.error('Gemini error', upstreamStatus, JSON.stringify(payload).slice(0, 1600));

        // Gemini의 상태 코드를 그대로 전달하여 앱이 429와 서버 오류를 구분할 수 있게 합니다.
        const status = [400, 401, 403, 404, 408, 429].includes(upstreamStatus) || upstreamStatus >= 500
          ? upstreamStatus
          : 502;
        return json({
          error: 'GEMINI_REQUEST_FAILED',
          status: upstreamStatus,
          message: upstreamMessage,
          retryAfterSeconds: retrySeconds || undefined,
        }, status, origin, retrySeconds ? { 'Retry-After': String(retrySeconds) } : {});
      }

      const text = extractText(payload);
      if (!text) return json({ error: 'EMPTY_GEMINI_RESPONSE' }, 502, origin);

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return json({ error: 'INVALID_GEMINI_JSON' }, 502, origin);
      }

      return json(normalizeResult(parsed), 200, origin);
    } catch (error) {
      console.error('Worker error', error?.message || error);
      const code = error?.message || 'INTERNAL_ERROR';
      const status = ['INVALID_IMAGE', 'IMAGE_TOO_LARGE'].includes(code) ? 400 : 500;
      return json({ error: code }, status, origin);
    }
  },
};
