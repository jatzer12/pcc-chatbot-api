import OpenAI from "openai";

/**
 * PCC Chatbot API (GitHub KB version)
 * - Reads KB files from jatzer12/PCC-Chatbot/kb/
 * - Retrieves relevant snippets (keyword-based)
 * - Injects snippets into the model as system context
 * - Returns { reply } to match your frontend
 */

/** ---------- Config ---------- */
const ALLOWED_ORIGIN = "https://jatzer12.github.io";

const ESCALATION_PHONE = "808-293-3160";
const ESCALATION_EMAIL = "mis@polynesia.com";

const GITHUB_OWNER = "jatzer12";
const GITHUB_REPO = "PCC-Chatbot";
const GITHUB_BRANCH = "main";
const RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}`;

let KB_CACHE = null;
let KB_CACHE_AT = 0;
const KB_TTL_MS = 5 * 60 * 1000;

/** ---------- OpenAI Client (lazy init so missing env is reported cleanly) ---------- */
function getOpenAIClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  return new OpenAI({ apiKey: key });
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
    "- If escalating (IT only): One short sentence + the phone and email lines."
  ].join("\n")
};

/** ---------- Retrieval Helpers ---------- */
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
    i += (chunkSize - overlap);
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
  const now = Date.now();
  if (KB_CACHE && (now - KB_CACHE_AT) < KB_TTL_MS) return KB_CACHE;

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
        text: ch
      });
    });
  }

  KB_CACHE = docs;
  KB_CACHE_AT = now;
  return docs;
}

function retrieveSnippets(query, docs, topK = 5) {
  const qTokens = tokenize(query);
  return docs
    .map(d => ({ ...d, score: scoreChunk(qTokens, d.text) }))
    .filter(d => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/** ---------- Handler ---------- */
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // Clear error if env is missing (common cause of 500)
    const openai = getOpenAIClient();
    if (!openai) {
      return res.status(500).json({
        error: "Missing OPENAI_API_KEY in Vercel environment variables."
      });
    }

    const body = req.body || {};

    // Your frontend sends { messages }
    const incomingMessages = Array.isArray(body.messages) ? body.messages : null;
    const fallbackMessage = typeof body.message === "string" ? body.message : "";

    const userMessages =
      (incomingMessages && incomingMessages.length)
        ? incomingMessages.filter(m => m && m.role && m.content && m.role !== "system")
        : [{ role: "user", content: fallbackMessage }];

    const latestUser = [...userMessages].reverse().find(m => m.role === "user");
    const latestUserText = latestUser?.content ? String(latestUser.content) : "";

    // Load KB and retrieve
    const kbDocs = await loadKB();
    const hits = latestUserText ? retrieveSnippets(latestUserText, kbDocs, 5) : [];

    const kbBlock = hits.length
      ? [
          "KNOWLEDGE BASE SNIPPETS (use as source of truth):",
          ...hits.map((r, i) => {
            return `(${i + 1}) title="${r.title}" | id="${r.id}" | score=${r.score}\n${r.text}`;
          })
        ].join("\n\n")
      : "KNOWLEDGE BASE SNIPPETS: (none found for this question)";

    const kbSystemMessage = {
      role: "system",
      content:
        kbBlock +
        "\n\nRULE: If the answer is not in the KB snippets and you are not sure, say you are not sure and provide the best next step."
    };

    const messagesForModel = [SYSTEM_MESSAGE, kbSystemMessage, ...userMessages];

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: messagesForModel,
      temperature: 0.2
    });

    const reply = completion?.choices?.[0]?.message?.content?.trim() || "Sorry—no reply returned.";
    return res.status(200).json({ reply });
  } catch (err) {
    console.error("API crash:", err);
    return res.status(500).json({
      error: err?.message || "Server error",
      hint: "Check Vercel logs. Most common causes: missing OPENAI_API_KEY, or KB files not reachable via GitHub RAW."
    });
  }
}
