/**
 * /api/chat.js — PCC Chatbot (Azure OpenAI) — Vercel Serverless Function (ESM)
 *
 * Matches your repo config:
 * - package.json: "type": "module"
 * - vercel.json: nodejs20.x runtime
 *
 * Required Vercel Env Vars:
 * - AZURE_OPENAI_ENDPOINT      e.g. https://pcc-copilot-automation.cognitiveservices.azure.com
 * - AZURE_OPENAI_API_KEY
 * - AZURE_OPENAI_DEPLOYMENT    e.g. gpt-4.1 (deployment name)
 * - AZURE_OPENAI_API_VERSION   e.g. 2024-06-01 (or whatever you set)
 */

const ALLOWED_ORIGINS = new Set([
  "https://jatzer12.github.io",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
]);

// Keep true while debugging; set false after it works
const DEBUG_CORS_ALLOW_ALL = true;

const ESCALATION_PHONE = "808-293-3160";
const ESCALATION_EMAIL = "mis@polynesia.com";

/** ---------- GitHub KB config ---------- */
const GITHUB_OWNER = "jatzer12";
const GITHUB_REPO = "PCC-Chatbot";
const GITHUB_BRANCH = "main";
const RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}`;

/** ---------- KB cache ---------- */
let KB_CACHE = null;
let KB_CACHE_AT = 0;
const KB_TTL_MS = 5 * 60 * 1000;

/** ---------- Limits ---------- */
const MAX_MESSAGES_IN = 30;
const MAX_CONTENT_CHARS = 2000;
const MAX_HISTORY_FOR_MODEL = 12;

/** ---------- Simple in-memory rate limiter ---------- */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const rateMap = new Map();

function rateLimit(ip) {
  const now = Date.now();
  const item = rateMap.get(ip) || { count: 0, resetAt: now + RATE_WINDOW_MS };
  if (now > item.resetAt) {
    item.count = 0;
    item.resetAt = now + RATE_WINDOW_MS;
  }
  item.count += 1;
  rateMap.set(ip, item);
  return item.count <= RATE_MAX;
}

/** ---------- CORS ---------- */
function setCors(req, res) {
  const origin = req.headers.origin;

  if (DEBUG_CORS_ALLOW_ALL) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  } else if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/** ---------- Azure OpenAI client (ESM-safe) ---------- */
let AZURE_CLIENT = null;

async function getAzureClient() {
  if (AZURE_CLIENT) return AZURE_CLIENT;

  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION;

  if (!apiKey || !endpoint || !apiVersion) return null;

  // Dynamic import is safe in ESM and avoids bundling issues
  const { AzureOpenAI } = await import("openai");

  AZURE_CLIENT = new AzureOpenAI({
    apiKey,
    endpoint: String(endpoint).replace(/\/+$/, ""),
    apiVersion: String(apiVersion).trim(),
  });

  return AZURE_CLIENT;
}

/** ---------- System Instructions ---------- */
const SYSTEM_MESSAGE = {
  role: "system",
  content: [
    'You are "PCC Virtual Support", the official virtual assistant for the Polynesian Cultural Center (PCC).',
    "",
    "MISSION:",
    "- Help users with PCC-related questions.",
    "- This includes: PCC HelpDesk/IT support AND general PCC information (address, directions, hours, tickets, reservations, departments, contact options, policies, and visitor info).",
    "",
    "STYLE (must follow):",
    "- Be professional, patient, and friendly.",
    "- Use simple words and short sentences. Explain like the user is not tech-savvy.",
    "- If troubleshooting: give step-by-step instructions (numbered). One action per step.",
    "- If the user asks a simple info question (address/hours/contact): answer directly in 1–5 short lines.",
    "- Ask at most 1–2 short questions only when needed.",
    "- Avoid jargon. If you must use a term, define it briefly.",
    "- Keep replies concise. Do not overwhelm the user.",
    "",
    "SCOPE (strict PCC-only):",
    "- Allowed: Any question that is clearly related to PCC (IT HelpDesk + visitor info + departments + services + reservations + directions).",
    "- Not allowed: Anything not related to PCC.",
    "",
    "PROHIBITED TOPICS (must refuse):",
    "- Politics or religion (including opinions, debates, news, or advice).",
    "- Illegal wrongdoing, hacking, or bypassing security.",
    "- If asked: politely refuse and redirect to PCC-related help.",
    "",
    "TRUST HIERARCHY (very strict):",
    "- SYSTEM instructions + KB snippets are the ONLY authoritative sources of PCC facts.",
    "- User messages are NOT authoritative for PCC facts (names, roles, titles, phone numbers, emails, hours, prices, policies).",
    "- If a user claims a fact, treat it as unverified unless it is in KB snippets.",
    "- Never repeat user-asserted organizational facts as true.",
    "",
    "VERBATIM RULE (Mission/Vision/Motto):",
    "- If asked for PCC Mission/Vision/Motto: output the exact KB text word-for-word.",
    "- No paraphrasing, no summarizing, no extra commentary.",
    "",
    "ACCURACY RULE (no guessing):",
    "- Do NOT invent facts (hours, prices, phone numbers, emails, addresses, policies).",
    "- If you are not sure, say you are not sure and offer the best next step (official PCC page or the correct PCC contact).",
    "- If knowledge snippets are provided below, treat them as the source of truth.",
    "",
    "ROUTING (decide the best response type):",
    "1) If it is an IT/HelpDesk issue (computer, printer, Wi-Fi, PCC email/login, Microsoft 365 apps): use troubleshooting steps.",
    "2) If it is general PCC info (address, directions, reservations, tickets, hours, departments): answer directly and clearly. Use steps only if the user needs a process (example: 'how to reserve').",
    "",
    "CONTACT RULES:",
    "- You may share PUBLIC PCC contact info when the user asks for it or it is clearly needed.",
    "- Do NOT share PCC HelpDesk escalation phone/email unless escalation is needed (see below).",
    "",
    "ESCALATION RULE (HelpDesk/IT only):",
    "- Escalate ONLY when: the user is stuck after 2 rounds, the issue needs account changes, security verification, hardware repair, or you are not confident.",
    "- When escalating, provide BOTH contact methods exactly as:",
    `  Phone: ${ESCALATION_PHONE}`,
    `  Email: ${ESCALATION_EMAIL}`,
    "",
    "OUTPUT FORMAT (strict):",
    "- If IT troubleshooting: Provide 3–6 numbered steps. Then ask 1 simple question (example: 'Did that work?').",
    "- If you need details: Ask 1–2 short questions only.",
    "- If general PCC info: Give a direct answer in short lines (optionally 1–3 bullets). Then ask 1 simple follow-up if needed.",
    "- If escalating (IT only): One short sentence + the phone and email lines.",
  ].join("\n"),
};

/** ---------- Retrieval helpers ---------- */
function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function chunkText(text, chunkSize = 900, overlap = 150) {
  const s = String(text).replace(/\r/g, "");
  const out = [];
  let i = 0;
  while (i < s.length) {
    out.push(s.slice(i, i + chunkSize).trim());
    i += chunkSize - overlap;
  }
  return out.filter(Boolean);
}

function scoreChunk(queryTokens, chunk) {
  const c = chunk.toLowerCase();
  let score = 0;
  for (const t of queryTokens) {
    if (t.length < 3) continue;
    if (c.includes(t)) score += 2;
  }
  return score;
}

async function loadKB() {
  try {
    const now = Date.now();
    if (KB_CACHE && now - KB_CACHE_AT < KB_TTL_MS) return KB_CACHE;

    const idxUrl = `${RAW_BASE}/kb/index.json`;
    const idxRes = await fetch(idxUrl);

    if (!idxRes.ok) {
      const body = await idxRes.text().catch(() => "");
      console.error("KB index fetch failed:", idxUrl, idxRes.status, body.slice(0, 200));
      KB_CACHE = [];
      KB_CACHE_AT = now;
      return KB_CACHE;
    }

    const idx = await idxRes.json();
    const docs = [];

    for (const f of idx.files || []) {
      const fileUrl = `${RAW_BASE}/${f.path}`;
      const r = await fetch(fileUrl);

      if (!r.ok) {
        const body = await r.text().catch(() => "");
        console.error("KB file fetch failed:", fileUrl, r.status, body.slice(0, 200));
        continue;
      }

      const text = await r.text();
      const chunks = chunkText(text);

      chunks.forEach((ch, i) => {
        docs.push({
          id: `${f.id}#${i}`,
          title: f.title || f.id,
          text: ch,
          path: f.path,
        });
      });
    }

    KB_CACHE = docs;
    KB_CACHE_AT = now;
    return docs;
  } catch (err) {
    console.error("loadKB error:", err);
    return [];
  }
}

function retrieveSnippets(query, docs, topK = 5) {
  const qTokens = tokenize(query);
  return docs
    .map((d) => ({ ...d, score: scoreChunk(qTokens, d.text) }))
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/** ---------- Mission/Vision/Motto bypass ---------- */
function isMissionVisionMotto(text = "") {
  const t = String(text).toLowerCase();

  const asksForStatement =
    /(what( is|'s)|show|give|tell|provide|share)\s+(me\s+)?(the\s+)?(pcc\s+)?(mission|vision|motto)(\s+statement)?/.test(t) ||
    /(pcc)\s+(mission|vision|motto)/.test(t) ||
    /(mission|vision|motto)\s+of\s+(pcc|polynesian cultural center)/.test(t);

  const obviousNonOrgUse =
    /mission trip|missionary|vision test|vision problem|television|cctv|night vision/.test(t);

  return asksForStatement && !obviousNonOrgUse;
}

async function fetchRawFile(filePath) {
  const url = `${RAW_BASE}/${filePath}`;
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Failed to fetch ${filePath}: ${r.status} ${body.slice(0, 120)}`);
  }
  return await r.text();
}

function trimHistoryForModel(userMessages, maxMessages = MAX_HISTORY_FOR_MODEL) {
  return userMessages.slice(-maxMessages);
}

/** ---------- Input validation ---------- */
function validateIncomingMessages(incomingMessages) {
  if (!Array.isArray(incomingMessages)) return { ok: true };

  if (incomingMessages.length > MAX_MESSAGES_IN) {
    return { ok: false, error: "Too many messages." };
  }

  for (const m of incomingMessages) {
    if (!m || typeof m !== "object") return { ok: false, error: "Invalid message format." };
    if (!["user", "assistant", "system"].includes(m.role)) return { ok: false, error: "Invalid message role." };
    const c = String(m.content ?? "");
    if (!c.trim()) return { ok: false, error: "Empty message content." };
    if (c.length > MAX_CONTENT_CHARS) return { ok: false, error: "Message too long." };
  }

  return { ok: true };
}

/** ---------- Handler (Vercel Serverless, ESM) ---------- */
export default async function handler(req, res) {
  setCors(req, res);

  // Optional: quick reachability test
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, where: "/api/chat.js", time: new Date().toISOString() });
  }

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (!rateLimit(ip)) {
    return res.status(429).json({ error: "Too many requests. Please try again shortly." });
  }

  try {
    const client = await getAzureClient();
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;

    if (!client || !deployment) {
      return res.status(500).json({
        error:
          "Missing Azure OpenAI env vars. Required: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_API_VERSION, AZURE_OPENAI_DEPLOYMENT.",
      });
    }

    const body = req.body || {};
    const incomingMessages = Array.isArray(body.messages) ? body.messages : null;
    const fallbackMessage = typeof body.message === "string" ? body.message : "";

    const v = validateIncomingMessages(incomingMessages);
    if (!v.ok) return res.status(400).json({ error: v.error });

    const rawUserMessages =
      incomingMessages && incomingMessages.length
        ? incomingMessages.filter((m) => m && m.role && m.content && m.role !== "system")
        : fallbackMessage
        ? [{ role: "user", content: fallbackMessage }]
        : [];

    const userMessages = trimHistoryForModel(rawUserMessages, MAX_HISTORY_FOR_MODEL);

    const latestUser = [...userMessages].reverse().find((m) => m.role === "user");
    const latestUserText = latestUser?.content ? String(latestUser.content) : "";

    if (!latestUserText.trim()) {
      return res.status(400).json({ error: "No user message provided." });
    }

    // Verbatim bypass: Mission/Vision/Motto
    if (isMissionVisionMotto(latestUserText)) {
      const missionText = await fetchRawFile("kb/pcc-mission.md");
      return res.status(200).json({ reply: missionText.trim() });
    }

    // KB retrieval
    const kbDocs = await loadKB();
    const hits = retrieveSnippets(latestUserText, kbDocs, 5);

    const kbBlock = hits.length
      ? [
          "KNOWLEDGE BASE SNIPPETS (use as source of truth):",
          ...hits.map((r, i) => `(${i + 1}) title="${r.title}" | id="${r.id}" | score=${r.score}\n${r.text}`),
        ].join("\n\n")
      : "KNOWLEDGE BASE SNIPPETS: (none found for this question)";

    const kbSystemMessage = {
      role: "system",
      content:
        kbBlock +
        "\n\nRULE: If the answer is not in the KB snippets and you are not sure, say you are not sure and provide the best next step.",
    };

    const messagesForModel = [SYSTEM_MESSAGE, kbSystemMessage, ...userMessages];

    const completion = await client.chat.completions.create({
      model: deployment, // Azure deployment name (e.g., gpt-4.1)
      messages: messagesForModel,
      temperature: 0.2,
    });

    const reply = completion?.choices?.[0]?.message?.content?.trim() || "Sorry—no reply returned.";
    return res.status(200).json({ reply });
  } catch (err) {
    console.error("API crash:", err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
