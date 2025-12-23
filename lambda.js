// index.js (ESM) — AWS Lambda backend with server.js feature parity + optional SSE streaming
// - Works as buffered JSON everywhere
// - Streams via SSE when Lambda Response Streaming is available (Function URL / ALB / supported HTTP API setups)

import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

console.log("[boot] streamifyResponse available =", !!globalThis.awslambda?.streamifyResponse);

// ============ ENV ============
const REGION = process.env.AWS_REGION || process.env.REGION || "eu-central-1";
const SECRET_ID = process.env.OPENAI_SECRET_ID || "solarchat/openai";
const MODEL = process.env.OPENAI_MODEL || "gpt-5-nano";

const CORS_ORIGIN = process.env.CORS_ORIGIN || "https://solarchat.eu";

// menu/context
const MENU_FILE = process.env.MENU_FILE || "turkiz.txt"; // if bundled in the zip
const MENU_S3_BUCKET = process.env.MENU_S3_BUCKET || "";
const MENU_S3_KEY = process.env.MENU_S3_KEY || "";

// limits / tuning (server.js parity)
const MAX_MENU_CHUNK = 15000;
const HISTORY_MAX = 16;
const HISTORY_TRIM_LEN = 500;
const USER_TRIM_LEN = 1000;

const CACHE_TTL = 6 * 60 * 60 * 1000;

const RL_WINDOW_MS = 60 * 1000;
const RL_LIMIT = 12;

const SPAM_WINDOW_MS = 5 * 60 * 1000;
const SPAM_LIMIT = 30;
const SPAM_BLOCK_MS = 3 * 60 * 1000;
const MIN_INTERVAL_MS = 650;

// ============ LAMBDA STREAMING HOOKS ============
const awslambda = globalThis.awslambda; // present only when invocation supports response streaming
const streamifyResponse = awslambda?.streamifyResponse;
const HttpResponseStream = awslambda?.HttpResponseStream;

// ============ CACHES (persist across warm invocations) ============
let _cachedApiKey;
let _cachedMenuText;

const cache = new Map();     // cacheKey -> { ts, reply }
const spamState = new Map(); // clientKey -> { windowStart, count, blockedUntil, lastAt }
const rateState = new Map(); // clientKey -> { windowStart, count, resetAt }
const inFlight = new Map();  // clientKey -> true

// categories must match frontend keys (server.js used these)
const VALID_CATEGORIES = new Set(["full", "starters_soups", "mains", "desserts", "drinks", "info"]);

const PRICING_PER_1M = {
  "gpt-5-nano": { input: 0.05, cached_input: 0.005, output: 0.40 },
};

function estimateCostUsd(model, usage) {
  const p = PRICING_PER_1M[model];
  if (!p || !usage) return null;

  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;

  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const uncached = Math.max(0, prompt - cached);

  const cost =
    (uncached / 1e6) * p.input +
    (cached / 1e6) * p.cached_input +
    (completion / 1e6) * p.output;

  return cost;

  

}


// ============ HELPERS ============
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  };
}

function json(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      ...corsHeaders(),
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  };
}

function getReqMeta(event) {
  const method =
    event?.requestContext?.http?.method ||
    event?.httpMethod ||
    event?.requestContext?.httpMethod ||
    "GET";

  const p =
    event?.rawPath ||
    event?.requestContext?.http?.path ||
    event?.path ||
    "/";

  return { method, path: p };
}

function getIp(event) {
  return (
    event?.requestContext?.identity?.sourceIp ||
    event?.requestContext?.http?.sourceIp ||
    (event?.headers?.["x-forwarded-for"] || "").split(",")[0].trim() ||
    ""
  );
}

function msNow() { return Date.now(); }

async function readBodyAsString(event) {
  if (!event?.body) return "";
  if (event.isBase64Encoded) return Buffer.from(event.body, "base64").toString("utf8");
  return event.body;
}

async function readBodyAsJson(event) {
  const raw = await readBodyAsString(event);
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch {
    const err = new Error("Invalid JSON body");
    err.statusCode = 400;
    throw err;
  }
}

async function getOpenAIApiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  if (_cachedApiKey) return _cachedApiKey;

  const sm = new SecretsManagerClient({ region: REGION });
  const res = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));

  let secret = res?.SecretString ?? "";
  if (!secret && res?.SecretBinary) {
    secret = Buffer.from(res.SecretBinary, "base64").toString("utf8");
  }
  secret = String(secret || "").trim();
  if (!secret) throw new Error(`Secret empty: ${SECRET_ID}`);

  if (secret.startsWith("{")) {
    try {
      const obj = JSON.parse(secret);
      _cachedApiKey = obj?.OPENAI_API_KEY || obj?.apiKey || obj?.key || "";
    } catch {}
  }
  if (!_cachedApiKey) _cachedApiKey = secret;
  if (!_cachedApiKey) throw new Error(`Missing OPENAI_API_KEY in secret: ${SECRET_ID}`);
  return _cachedApiKey;
}

async function streamToString(readable) {
  const chunks = [];
  for await (const ch of readable) chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch));
  return Buffer.concat(chunks).toString("utf8");
}

async function getMenuText() {
  if (_cachedMenuText) return _cachedMenuText;

  if (MENU_S3_BUCKET && MENU_S3_KEY) {
    const s3 = new S3Client({ region: REGION });
    const res = await s3.send(new GetObjectCommand({ Bucket: MENU_S3_BUCKET, Key: MENU_S3_KEY }));
    const text = await streamToString(res.Body);
    _cachedMenuText = String(text || "").trim();
    return _cachedMenuText;
  }

  const filePath = path.join(process.cwd(), MENU_FILE);
  _cachedMenuText = String(fs.readFileSync(filePath, "utf8") || "").trim();
  return _cachedMenuText;
}

// ===== Category chunking (mirror server.js markers) =====
function indexOfRegex(text, regex, from = 0) {
  const slice = text.slice(from);
  const m = slice.match(regex);
  if (!m || m.index == null) return -1;
  return from + m.index;
}

function getMenuChunkFromText(restaurantInfo, category) {
  const t = String(restaurantInfo || "");
  if (!t.trim()) return "";

  const RX_MEZE = /MEZE\s*\/\s*MEZZE/i;
  const RX_OVEN = /PÉKÜNK KEMENCÉJÉBŐL/i;
  const RX_DESSERTS = /DESSZERTEK\s*\/\s*DESSERTS/i;
  const RX_DRINKS = /ITALOK\s*\/\s*DRINKS/i;
  const RX_FOOTER = /Az árak forintban értendőek/i;

  const posMeze = indexOfRegex(t, RX_MEZE);
  const posOven = indexOfRegex(t, RX_OVEN);
  const posDesserts = indexOfRegex(t, RX_DESSERTS);
  const posDrinks = indexOfRegex(t, RX_DRINKS);
  const posFooter = indexOfRegex(t, RX_FOOTER);

  if (posMeze < 0 && posDesserts < 0 && posDrinks < 0) {
    return t.slice(0, MAX_MENU_CHUNK);
  }

  if (category === "info") {
    const introEnd = posMeze > 0 ? posMeze : Math.min(2000, t.length);
    const intro = t.slice(0, introEnd).trim();
    const tail = posFooter >= 0 ? t.slice(posFooter).trim() : "";
    return [intro, tail].filter(Boolean).join("\n\n").slice(0, MAX_MENU_CHUNK);
  }

  if (category === "starters_soups") {
    const start = posMeze >= 0 ? posMeze : 0;
    const end = posOven >= 0 ? posOven : (posDesserts >= 0 ? posDesserts : (posDrinks >= 0 ? posDrinks : t.length));
    return t.slice(start, end).trim().slice(0, MAX_MENU_CHUNK);
  }

  if (category === "mains") {
    const start = posOven >= 0 ? posOven : (posMeze >= 0 ? posMeze : 0);
    const end = posDesserts >= 0 ? posDesserts : (posDrinks >= 0 ? posDrinks : t.length);
    return t.slice(start, end).trim().slice(0, MAX_MENU_CHUNK);
  }

  if (category === "desserts") {
    const start = posDesserts >= 0 ? posDesserts : 0;
    const end = posDrinks >= 0 ? posDrinks : t.length;
    return t.slice(start, end).trim().slice(0, MAX_MENU_CHUNK);
  }

  if (category === "drinks") {
    const start = posDrinks >= 0 ? posDrinks : 0;
    const end = posFooter >= 0 ? posFooter : t.length;
    return t.slice(start, end).trim().slice(0, MAX_MENU_CHUNK);
  }

  return t.slice(0, MAX_MENU_CHUNK);
}

function normalizeCategory(category) {
  return VALID_CATEGORIES.has(category) ? category : "full";
}

function buildMessages({ message, history, category, restaurantInfo }) {
  const safeCategory = normalizeCategory(category);

  const systemPrompt = `
You are a friendly, professional AI assistant for the TÜRKIZ restaurant website.

CURRENT TOPIC
- The user selected this topic: ${safeCategory}
- Answer ONLY questions that belong to this selected topic.
- If the user asks about another topic, politely ask them to switch topic in the UI.

LANGUAGE & STYLE
- Respond politely and naturally in the customer's language.
- Keep it short: 1–2 short sentences OR up to 3 simple bullet points.
- Avoid hallucinations: NEVER invent dishes, prices, policies, or details.

RECOMMENDATIONS
- Recommend food/drinks only when asked what to eat/drink.
- Suggest 2–3 items from the context, briefly.
`.trim();

  const menuChunk =
    safeCategory === "full"
      ? String(restaurantInfo || "").slice(0, MAX_MENU_CHUNK)
      : getMenuChunkFromText(restaurantInfo, safeCategory);

  const menuContext = `
RESTAURANT / MENU CONTEXT (topic: ${safeCategory})
Use this text as the ONLY source of truth:

${menuChunk}
`.trim();

  const safeHist = Array.isArray(history)
    ? history.slice(-HISTORY_MAX).map((h) => ({
        role: h?.role,
        content: String(h?.content || "").slice(0, HISTORY_TRIM_LEN),
      }))
    : [];

  return [
    { role: "system", content: systemPrompt },
    { role: "system", content: menuContext },
    ...safeHist,
    { role: "user", content: String(message || "").slice(0, USER_TRIM_LEN) },
  ];
}

function makeCacheKey(message, history, category) {
  const safeCategory = normalizeCategory(category);
  const h = Array.isArray(history) ? history.slice(-4) : [];
  const hKey = h.map((x) => `${x?.role || ""}:${String(x?.content || "").slice(0, 140)}`).join("|");
  return `${safeCategory}::${String(message || "").slice(0, 600)}::${hKey}`;
}

function cleanupCache() {
  const now = msNow();
  for (const [k, v] of cache.entries()) {
    if (!v || (now - v.ts) > CACHE_TTL) cache.delete(k);
  }
}

function getClientKey({ clientId, ip }) {
  if (clientId && typeof clientId === "string" && clientId.length >= 8) return `cid:${clientId}`;
  return `ip:${ip || "unknown"}`;
}

function applyRateLimitOrThrow(key) {
  const now = msNow();
  const st = rateState.get(key) || { windowStart: now, count: 0, resetAt: now + RL_WINDOW_MS };

  if (now - st.windowStart > RL_WINDOW_MS) {
    st.windowStart = now;
    st.count = 0;
    st.resetAt = now + RL_WINDOW_MS;
  }

  st.count += 1;
  rateState.set(key, st);

  if (st.count > RL_LIMIT) {
    const retryAfterSec = Math.max(1, Math.ceil((st.resetAt - now) / 1000));
    const err = new Error("RATE_LIMIT");
    err.statusCode = 429;
    err.retryAfterSec = retryAfterSec;
    throw err;
  }
}

function applySpamGuardOrThrow(key) {
  const now = msNow();
  const st = spamState.get(key) || { windowStart: now, count: 0, blockedUntil: 0, lastAt: 0 };

  if (st.blockedUntil && now < st.blockedUntil) {
    const retryAfterSec = Math.max(1, Math.ceil((st.blockedUntil - now) / 1000));
    const err = new Error("COOLDOWN");
    err.statusCode = 429;
    err.retryAfterSec = retryAfterSec;
    err.spam = true;
    throw err;
  }

  if (st.lastAt && (now - st.lastAt) < MIN_INTERVAL_MS) {
    st.blockedUntil = now + 3000;
    spamState.set(key, st);
    const err = new Error("TOO_FAST");
    err.statusCode = 429;
    err.retryAfterSec = 3;
    err.spam = true;
    throw err;
  }

  if ((now - st.windowStart) > SPAM_WINDOW_MS) {
    st.windowStart = now;
    st.count = 0;
  }

  st.count += 1;
  st.lastAt = now;

  if (st.count > SPAM_LIMIT) {
    st.blockedUntil = now + SPAM_BLOCK_MS;
    spamState.set(key, st);
    const retryAfterSec = Math.max(1, Math.ceil(SPAM_BLOCK_MS / 1000));
    const err = new Error("SPAM_WINDOW");
    err.statusCode = 429;
    err.retryAfterSec = retryAfterSec;
    err.spam = true;
    throw err;
  }

  spamState.set(key, st);
}

function applyBusyGuardOrThrow(key) {
  if (inFlight.get(key)) {
    const err = new Error("BUSY");
    err.statusCode = 409;
    throw err;
  }
  inFlight.set(key, true);
}
function clearBusy(key) { inFlight.delete(key); }

// ============ ROUTES ============
async function handleHealth() {
  return json(200, { ok: true, region: REGION, model: MODEL, time: new Date().toISOString() });
}

async function computeReply({ message, history, category }) {
  cleanupCache();

  const restaurantInfo = await getMenuText();
  const messages = buildMessages({ message, history, category, restaurantInfo });

  const cacheKey = makeCacheKey(message, history, category);
  const cached = cache.get(cacheKey);
  if (cached && msNow() - cached.ts < CACHE_TTL) {
    return { reply: cached.reply, cached: true };
  }

  const apiKey = await getOpenAIApiKey();
  const client = new OpenAI({ apiKey });

  const resp = await client.chat.completions.create({
    model: MODEL,
    messages,
    reasoning_effort: "low",
  });

  const reply = resp?.choices?.[0]?.message?.content?.trim() || "";
  cache.set(cacheKey, { ts: msNow(), reply });
  return { reply, cached: false };
}

async function handleChatBuffered(event) {
  const body = await readBodyAsJson(event);
  const message = String(body?.message || "");
  const history = Array.isArray(body?.history) ? body.history : [];
  const category = normalizeCategory(body?.category);

  if (!message) return json(400, { ok: false, error: "NO_MESSAGE" });

  const ip = getIp(event);
  const key = getClientKey({ clientId: body?.clientId, ip });

  applyRateLimitOrThrow(key);
  applySpamGuardOrThrow(key);
  applyBusyGuardOrThrow(key);

  try {
    const out = await computeReply({ message, history, category });
    return json(200, { ok: true, reply: out.reply, answer: out.reply, cached: out.cached });
  } finally {
    clearBusy(key);
  }
}

async function handleChatStream(event, responseStream) {
  const body = await readBodyAsJson(event);
  const message = String(body?.message || "");
  const history = Array.isArray(body?.history) ? body.history : [];
  const category = normalizeCategory(body?.category);

  if (!message) {
    const payload = json(400, { ok: false, error: "NO_MESSAGE" });
    responseStream.write(payload.body);
    responseStream.end();
    return;
  }

  const ip = getIp(event);
  const key = getClientKey({ clientId: body?.clientId, ip });

  applyRateLimitOrThrow(key);
  applySpamGuardOrThrow(key);
  applyBusyGuardOrThrow(key);

  try {
    cleanupCache();

    const restaurantInfo = await getMenuText();
    const messages = buildMessages({ message, history, category, restaurantInfo });

    const cacheKey = makeCacheKey(message, history, category);
    const cached = cache.get(cacheKey);

    const meta = {
      statusCode: 200,
      headers: {
        ...corsHeaders(),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Connection": "keep-alive",
      },
    };

    responseStream = HttpResponseStream.from(responseStream, meta);

    if (cached && msNow() - cached.ts < CACHE_TTL) {
      responseStream.write(`data: ${JSON.stringify({ delta: cached.reply, cached: true })}\n\n`);
      responseStream.write(`data: [DONE]\n\n`);
      responseStream.end();
      return;
    }

    const apiKey = await getOpenAIApiKey();
    const client = new OpenAI({ apiKey });

    const stream = await client.chat.completions.create({
      model: MODEL,
      messages,
      reasoning_effort: "low",
      stream: true,
    });

    let full = "";
    for await (const part of stream) {
      const delta = part?.choices?.[0]?.delta?.content || "";
      if (!delta) continue;
      full += delta;
      responseStream.write(`data: ${JSON.stringify({ delta })}\n\n`);
    }

    full = full.trim();
    cache.set(cacheKey, { ts: msNow(), reply: full });

    responseStream.write(`data: [DONE]\n\n`);
    responseStream.end();
  } catch (err) {
    try {
      responseStream.write(`data: ${JSON.stringify({ error: "SERVER_ERROR" })}\n\n`);
      responseStream.write(`data: [DONE]\n\n`);
      responseStream.end();
    } catch {}
    throw err;
  } finally {
    clearBusy(key);
  }
}

async function routeBuffered(event) {
  const { method, path: p0 } = getReqMeta(event);

  if (method === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };

  const p = p0 || "/";
  const ends = (suffix) => p === suffix || p.endsWith(suffix);

  if (method === "GET" && ends("/health")) return await handleHealth();
  if (method === "POST" && ends("/api/chat")) return await handleChatBuffered(event);

  // streaming not available => fallback to JSON
  if (method === "POST" && ends("/api/chat-stream")) return await handleChatBuffered(event);

  return json(404, { ok: false, error: "NOT_FOUND", method, path: p });
}

const handlerImpl = streamifyResponse
  ? streamifyResponse(async (event, responseStream) => {
      const { method, path: p0 } = getReqMeta(event);

      if (method === "OPTIONS") {
        const meta = { statusCode: 204, headers: corsHeaders() };
        responseStream = HttpResponseStream.from(responseStream, meta);
        responseStream.end();
        return;
      }

      const p = p0 || "/";
      const ends = (suffix) => p === suffix || p.endsWith(suffix);

      try {
        if (method === "GET" && ends("/health")) {
          const out = await handleHealth();
          const meta = { statusCode: out.statusCode, headers: out.headers };
          responseStream = HttpResponseStream.from(responseStream, meta);
          responseStream.write(out.body);
          responseStream.end();
          return;
        }

        if (method === "POST" && ends("/api/chat-stream")) {
          await handleChatStream(event, responseStream);
          return;
        }

        if (method === "POST" && ends("/api/chat")) {
          const out = await handleChatBuffered(event);
          const meta = { statusCode: out.statusCode, headers: out.headers };
          responseStream = HttpResponseStream.from(responseStream, meta);
          responseStream.write(out.body);
          responseStream.end();
          return;
        }

        const out = json(404, { ok: false, error: "NOT_FOUND", method, path: p });
        const meta = { statusCode: out.statusCode, headers: out.headers };
        responseStream = HttpResponseStream.from(responseStream, meta);
        responseStream.write(out.body);
        responseStream.end();
      } catch (err) {
        const statusCode = err?.statusCode || 500;
        const extraHeaders = {};
        if (statusCode === 429 && err?.retryAfterSec) extraHeaders["Retry-After"] = String(err.retryAfterSec);

        const out = json(statusCode, {
          ok: false,
          error: err?.message || "SERVER_ERROR",
          ...(err?.retryAfterSec ? { retryAfterSec: err.retryAfterSec } : {}),
        }, extraHeaders);

        const meta = { statusCode: out.statusCode, headers: out.headers };
        responseStream = HttpResponseStream.from(responseStream, meta);
        responseStream.write(out.body);
        responseStream.end();
      }
    })
  : routeBuffered;

export const handler = handlerImpl;
