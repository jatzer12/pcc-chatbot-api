import OpenAI from "openai";

/**
 * ✅ CORS allowlist
 * NOTE: CORS only affects browsers. It does not stop curl/Postman.
 */
const ALLOWED_ORIGINS = new Set([
  "https://jatzer12.github.io",
  "http://localhost:5500" // optional for local testing
]);

/**
 * ✅ Basic IP rate limiting (best-effort on Vercel serverless)
 * - 20 requests per minute per IP
 * You can tune RATE_MAX higher/lower.
 */
const RATE_WINDOW_MS = 60_000; // 1 minute
const RATE_MAX = 20;
const rateStore = new Map(); // ip -> { count, reset }

function getClientIp(req) {
  const xff = (req.headers["x-forwarded-for"] || "").toString();
  // x-forwarded-for can be "client, proxy1, proxy2"
  const ip = (xff.split(",")[0] || req.socket?.remoteAddress || "unknown").trim();
  return ip || "unknown";
}

function rateLimit(ip) {
  const now = Date.now();
  const entry = rateStore.get(ip);

  if (!entry || now > entry.reset) {
    rateStore.set(ip, { count: 1, reset: now + RATE_WINDOW_MS });
    return { ok: true };
  }

  if (entry.count >= RATE_MAX) {
    return { ok: false, retryInMs: entry.reset - now };
  }

  entry.count += 1;
  return { ok: true };
}

function setCors(req, res) {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/**
 * ✅ OpenAI client (API key stays server-side in Vercel env vars)
 */
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

function isHelpdeskTopic(text = "") {
  const t = String(text).toLowerCase();
  const keywords = [
    "computer", "pc", "laptop",
    "printer", "printing",
    "wifi", "wi-fi", "internet", "network",
    "email", "outlook",
    "password", "login", "mfa",
    "windows", "monitor", "keyboard", "mouse",
    "teams", "onedrive",
    "slow", "freezing", "freeze", "crash", "crashing", "stuck", "hang"
  ];
  return keywords.some((k) => t.includes(k));
}

/**
 * Decide scope using BOTH:
 * - the current message
 * - the recent conversation context
 */
function isInScope(message, history) {
  if (isHelpdeskTopic(message)) return true;

  const recent = Array.isArray(history) ? history.slice(-10) : [];
  const historyText = recent
    .map((h) => (h && typeof h.content === "string" ? h.content : ""))
    .join(" ");

  return isHelpdeskTopic(historyText);
}

/**
 * Keep history only in a safe format (role/content) and cap size.
 */
function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];

  const cleaned = history
    .filter((h) => h && typeof h === "object")
    .map((h) => ({
      role: h.role,
      content: typeof h.content === "string" ? h.content : ""
    }))
    .filter((h) => (h.role === "user" || h.role === "assistant") && h.content.trim().length > 0);

  return cleaned.slice(-20);
}

/**
 * ✅ Request validation (message + history)
 */
function validateRequestBody(body) {
  const message = body?.message;
  const history = body?.history ?? [];

  if (typeof message !== "string") {
    return { ok: false, error: "Message is required" };
  }

  const trimmed = message.trim();
  if (!trimmed) {
    return { ok: false, error: "Message is required" };
  }

  // length limit (adjust if you want)
  if (trimmed.length > 1500) {
    return { ok: false, error: "Message is too long (max 1500 characters)" };
  }

  // history must be an array if provided
  if (history !== undefined && !Array.isArray(history)) {
    return { ok: false, error: "History must be an array" };
  }

  return { ok: true, message: trimmed, history };
}

export default async function handler(req, res) {
  // ✅ CORS allowlist
  setCors(req, res);

  // ✅ Preflight
  if (req.method === "OPTIONS") return res.status(204).end();

  // ✅ Only POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ✅ Rate limit
  const ip = getClientIp(req);
  const rl = rateLimit(ip);
  if (!rl.ok) {
    res.setHeader("Retry-After", Math.ceil(rl.retryInMs / 1000));
    return res.status(429).json({ error: "Too many requests. Try again later." });
  }

  try {
    // ✅ Validate body
    const v = validateRequestBody(req.body || {});
    if (!v.ok) return res.status(400).json({ error: v.error });

    const safeHistory = normalizeHistory(v.history);

    // ✅ Scope check uses message OR history context
    if (!isInScope(v.message, safeHistory)) {
      return res.status(200).json({
        text:
          "I can assist with PCC HelpDesk issues only (computer, printer, Wi-Fi/internet, and account access).\n" +
          "For other concerns, please contact the PCC HelpDesk at 808-293-3160."
      });
    }

    const systemPrompt = `
You are PCC Helpdesk Virtual Assistant.

Scope:
- Only help with PCC HelpDesk issues: computer, printer, Wi-Fi/internet, and account access.

Response style:
- Short, friendly, step-by-step instructions.
- Simple language for non-technical users.
- Max 5 steps.
- Ask at most TWO questions at the end.
- Do not repeat the scope disclaimer unless the request is truly out of scope.

Formatting:
- Use line breaks.
- Put each step on its own line.
- If asking questions, put each question on its own line.

Escalation (only if needed):
Phone: 808-293-3160
Email: MIS@polynesia.com
`.trim();

    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: systemPrompt },
        ...safeHistory,
        { role: "user", content: v.message }
      ],
      max_output_tokens: 300
    });

    return res.status(200).json({ text: response.output_text });
  } catch (err) {
    // Don't leak details to the client
    console.error("API /api/chat error:", err?.message || err);
    return res.status(500).json({
      text:
        "Sorry — something went wrong on our side.\n" +
        "Please contact the PCC HelpDesk at 808-293-3160."
    });
  }
}
