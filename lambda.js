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
const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";

const CORS_ORIGIN = process.env.CORS_ORIGIN || "https://solarchat.eu";

// menu/context
const MENU_FILE = process.env.MENU_FILE || "turkiz.txt"; // if bundled in the zip
const MENU_S3_BUCKET = process.env.MENU_S3_BUCKET || "";
const MENU_S3_KEY = process.env.MENU_S3_KEY || "";

// limits / tuning (server.js parity)
const MAX_MENU_CHUNK = 15000;
const MAX_EMBED_CHUNK_CHARS = 1400;
const RETRIEVAL_TOP_K_DEFAULT = 4;
const RETRIEVAL_TOP_K_BROAD = 7;
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
let _cachedMenuChunks;
let _cachedMenuEmbeddings;
let _cachedIntentEmbeddings;

const cache = new Map();     // cacheKey -> { ts, reply }
const spamState = new Map(); // clientKey -> { windowStart, count, blockedUntil, lastAt }
const rateState = new Map(); // clientKey -> { windowStart, count, resetAt }
const inFlight = new Map();  // clientKey -> true

// categories must match frontend keys (server.js used these)
const VALID_CATEGORIES = new Set(["auto", "full", "starters_soups", "mains", "desserts", "drinks", "info"]);

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
  return VALID_CATEGORIES.has(category) ? category : "auto";
}

function splitSections(restaurantInfo) {
  const t = String(restaurantInfo || "");
  const RX_MEZE = /MEZE\s*\/\s*MEZZE/i;
  const RX_SOUPS = /LEVESEK\s*\/\s*SOUPS/i;
  const RX_OVEN = /PÉKÜNK KEMENCÉJÉBŐL/i;
  const RX_CHAR = /FASZÉNEN SÜLTEK\s*\/\s*CHAR GRILLED/i;
  const RX_CLASSICS = /KLASSZIKUSOK\s*\/\s*CLASSICS/i;
  const RX_SEA = /TENGER FINOMSÁGAI/i;
  const RX_SALADS = /SALÁTÁK\s*\/\s*SALADS/i;
  const RX_SIDES = /KÖRETEK\s*\/\s*SIDES/i;
  const RX_DESSERTS = /DESSZERTEK\s*\/\s*DESSERTS/i;
  const RX_DRINKS = /ITALOK\s*\/\s*DRINKS/i;
  const RX_FOOTER = /Az árak forintban értendőek/i;

  const markers = [
    { key: "meze", rx: RX_MEZE },
    { key: "soups", rx: RX_SOUPS },
    { key: "oven", rx: RX_OVEN },
    { key: "char", rx: RX_CHAR },
    { key: "classics", rx: RX_CLASSICS },
    { key: "sea", rx: RX_SEA },
    { key: "salads", rx: RX_SALADS },
    { key: "sides", rx: RX_SIDES },
    { key: "desserts", rx: RX_DESSERTS },
    { key: "drinks", rx: RX_DRINKS },
  ];

  const positions = markers
    .map((m) => ({ ...m, pos: indexOfRegex(t, m.rx) }))
    .filter((m) => m.pos >= 0)
    .sort((a, b) => a.pos - b.pos);

  const sections = [];

  if (positions.length) {
    const introEnd = positions[0].pos;
    if (introEnd > 0) sections.push({ key: "intro", text: t.slice(0, introEnd).trim() });
  } else if (t.trim()) {
    sections.push({ key: "intro", text: t.trim().slice(0, MAX_MENU_CHUNK) });
  }

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].pos;
    const end = i + 1 < positions.length ? positions[i + 1].pos : t.length;
    const text = t.slice(start, end).trim();
    if (text) sections.push({ key: positions[i].key, text });
  }

  const footerPos = indexOfRegex(t, RX_FOOTER);
  if (footerPos >= 0) {
    const footer = t.slice(footerPos).trim();
    if (footer) sections.push({ key: "footer", text: footer });
  }

  return sections.filter((s) => s.text);
}

function chunkSection(key, text) {
  const lines = String(text || "").split(/\r?\n/);
  const chunks = [];
  let buf = "";

  for (const line of lines) {
    const next = buf ? `${buf}\n${line}` : line;
    if (next.length > MAX_EMBED_CHUNK_CHARS && buf) {
      chunks.push(buf.trim());
      buf = line;
    } else {
      buf = next;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());

  return chunks.map((chunk, i) => ({
    id: `${key}:${i + 1}`,
    key,
    text: chunk,
  }));
}

function chunkMenuForEmbedding(restaurantInfo) {
  const sections = splitSections(restaurantInfo);
  const chunks = [];
  for (const section of sections) {
    for (const chunk of chunkSection(section.key, section.text)) {
      chunks.push(chunk);
    }
  }
  return chunks;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

async function getMenuEmbeddings(client, restaurantInfo) {
  if (_cachedMenuChunks && _cachedMenuEmbeddings) {
    return { chunks: _cachedMenuChunks, embeddings: _cachedMenuEmbeddings };
  }

  const chunks = chunkMenuForEmbedding(restaurantInfo);
  const embeddings = [];

  for (const chunk of chunks) {
    const resp = await client.embeddings.create({
      model: EMBED_MODEL,
      input: chunk.text.slice(0, MAX_EMBED_CHUNK_CHARS),
    });
    embeddings.push(resp.data[0].embedding);
  }

  _cachedMenuChunks = chunks;
  _cachedMenuEmbeddings = embeddings;

  return { chunks, embeddings };
}

async function getIntentEmbeddings(client) {
  if (_cachedIntentEmbeddings) return _cachedIntentEmbeddings;

  const intents = [
    { key: "recommendation", text: "User asks for recommendations or what to try today." },
    { key: "cheapest", text: "User asks for the cheapest or lowest priced option." },
    { key: "comparison", text: "User asks to compare items, prices, or differences." },
    { key: "general", text: "User asks general restaurant info or menu info." },
  ];

  const embeddings = [];
  for (const intent of intents) {
    const resp = await client.embeddings.create({
      model: EMBED_MODEL,
      input: intent.text,
    });
    embeddings.push(resp.data[0].embedding);
  }

  _cachedIntentEmbeddings = { intents, embeddings };
  return _cachedIntentEmbeddings;
}

async function detectIntent(client, queryEmbedding) {
  const { intents, embeddings } = await getIntentEmbeddings(client);
  let best = { key: "general", score: -1 };

  for (let i = 0; i < intents.length; i++) {
    const score = cosineSimilarity(queryEmbedding, embeddings[i]);
    if (score > best.score) best = { key: intents[i].key, score };
  }

  return best;
}

function buildMessages({ message, history, menuContext, intent }) {
  const systemPrompt = `
You are a friendly, professional AI assistant for the TÜRKIZ restaurant website.

SCOPE & ACCURACY
- Answer questions only using the provided restaurant/menu context.
- If the context does NOT contain the answer, say so clearly and briefly.
- NEVER invent dishes, prices, policies, or details.

LANGUAGE & STYLE
- Respond politely and naturally in the customer's language.
- Keep it short: 1–2 short sentences OR up to 3 simple bullet points.

RECOMMENDATIONS
- If the user asks for a recommendation but provides no preferences, ask 1–2 short clarifying questions first.
- If preferences are provided, suggest 2–3 items from the context only.

COMPARISONS & CHEAPEST
- For comparisons or "cheapest" requests, use prices from the context only.
- If you cannot compare due to missing items or prices, say that clearly and ask a clarifying question.

INTENT (internal): ${intent || "general"}
`.trim();

  const menuContextBlock = `
RESTAURANT / MENU CONTEXT
Use this text as the ONLY source of truth:

${menuContext}
`.trim();

  const safeHist = Array.isArray(history)
    ? history.slice(-HISTORY_MAX).map((h) => ({
        role: h?.role,
        content: String(h?.content || "").slice(0, HISTORY_TRIM_LEN),
      }))
    : [];

  return [
    { role: "system", content: systemPrompt },
    { role: "system", content: menuContextBlock },
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

async function buildMenuContextForQuery({ client, restaurantInfo, message }) {
  const { chunks, embeddings } = await getMenuEmbeddings(client, restaurantInfo);
  const queryResp = await client.embeddings.create({
    model: EMBED_MODEL,
    input: String(message || "").slice(0, USER_TRIM_LEN),
  });
  const queryEmbedding = queryResp.data[0].embedding;
  const intent = await detectIntent(client, queryEmbedding);

  const scored = embeddings.map((vec, i) => ({
    idx: i,
    score: cosineSimilarity(queryEmbedding, vec),
  }));
  scored.sort((a, b) => b.score - a.score);

  const topK = intent.key === "cheapest" || intent.key === "comparison"
    ? RETRIEVAL_TOP_K_BROAD
    : RETRIEVAL_TOP_K_DEFAULT;

  const selected = scored.slice(0, topK).map((s) => chunks[s.idx]);
  const intro = chunks.filter((c) => c.key === "intro").slice(0, 1);
  const footer = chunks.filter((c) => c.key === "footer").slice(0, 1);

  const unique = new Map();
  [...intro, ...footer, ...selected].forEach((chunk) => {
    if (!unique.has(chunk.id)) unique.set(chunk.id, chunk);
  });

  const menuContext = Array.from(unique.values())
    .map((chunk) => `### ${chunk.key.toUpperCase()} (${chunk.id})\n${chunk.text}`)
    .join("\n\n")
    .slice(0, MAX_MENU_CHUNK);

  return { menuContext, intent: intent.key };
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

  const cacheKey = makeCacheKey(message, history, category);
  const cached = cache.get(cacheKey);
  if (cached && msNow() - cached.ts < CACHE_TTL) {
    return { reply: cached.reply, cached: true };
  }

  const restaurantInfo = await getMenuText();
  const apiKey = await getOpenAIApiKey();
  const client = new OpenAI({ apiKey });
  const retrieval = await buildMenuContextForQuery({ client, restaurantInfo, message });
  const messages = buildMessages({
    message,
    history,
    menuContext: retrieval.menuContext,
    intent: retrieval.intent,
  });

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

    const restaurantInfo = await getMenuText();
    const apiKey = await getOpenAIApiKey();
    const client = new OpenAI({ apiKey });
    const retrieval = await buildMenuContextForQuery({ client, restaurantInfo, message });
    const messages = buildMessages({
      message,
      history,
      menuContext: retrieval.menuContext,
      intent: retrieval.intent,
    });

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
