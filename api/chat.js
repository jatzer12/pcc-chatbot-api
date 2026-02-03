import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Lock CORS to your GitHub Pages site
const ALLOWED_ORIGIN = "https://jatzer12.github.io";

// ✅ Escalation contact info (only used when needed)
const ESCALATION_PHONE = "808-293-3160";
const ESCALATION_EMAIL = "mis@polynesia.com";

// Server-only Supabase client (admin)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ✅ System instructions (your “training” / behavior rules)
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

async function getKbSnippets(latestUserText, topK = 5) {
  // 1) embed the question
  const emb = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: latestUserText
  });

  const queryEmbedding = emb.data?.[0]?.embedding;
  if (!queryEmbedding) return [];

  // 2) vector search against Supabase function
  const { data, error } = await supabaseAdmin.rpc("match_kb_chunks", {
    query_embedding: queryEmbedding,
    match_count: topK
  });

  if (error) {
    console.error("KB search error:", error);
    return [];
  }

  // Optional: keep only reasonably relevant results
  // similarity is 0..1 (higher is better). Adjust if needed.
  const filtered = (data || []).filter(r => (r.similarity ?? 0) >= 0.72);

  return filtered;
}

export default async function handler(req, res) {
  // --- CORS ---
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body || {};

    // ✅ Prefer full history from frontend
    const incomingMessages = Array.isArray(body.messages) ? body.messages : null;
    const message = typeof body.message === "string" ? body.message : "";

    const userMessages =
      (incomingMessages && incomingMessages.length)
        ? incomingMessages.filter(m => m && m.role && m.content && m.role !== "system")
        : [{ role: "user", content: message }];

    // Find latest user message for retrieval
    const latestUser = [...userMessages].reverse().find(m => m.role === "user");
    const latestUserText = latestUser?.content ? String(latestUser.content) : "";

    // 1) Retrieve KB snippets
    const kb = latestUserText ? await getKbSnippets(latestUserText, 5) : [];

    const kbBlock = kb.length
      ? [
          "KNOWLEDGE BASE SNIPPETS (use as source of truth):",
          ...kb.map((r, i) => {
            const meta = [
              r.title ? `title="${r.title}"` : null,
              r.category ? `category="${r.category}"` : null,
              r.doc_id ? `doc_id="${r.doc_id}"` : null,
              typeof r.similarity === "number" ? `similarity=${r.similarity.toFixed(3)}` : null
            ].filter(Boolean).join(" | ");

            return `(${i + 1}) ${meta}\n${r.content}`;
          })
        ].join("\n\n")
      : "KNOWLEDGE BASE SNIPPETS: (none found for this question)";

    // 2) Add KB block as an additional system message
    const kbSystemMessage = {
      role: "system",
      content: kbBlock + "\n\nRULE: If the answer is not in the KB snippets and you are not sure, say you are not sure and provide the best next step."
    };

    const messagesForModel = [SYSTEM_MESSAGE, kbSystemMessage, ...userMessages];

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: messagesForModel,
      temperature: 0.2
    });

    const reply = completion?.choices?.[0]?.message?.content?.trim() || "Sorry—no reply returned.";
    return res.status(200).json({ reply });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
