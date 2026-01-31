import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Lock CORS to your GitHub Pages site
const ALLOWED_ORIGIN = "https://jatzer12.github.io";

// ✅ Escalation contact info (only used when needed)
const ESCALATION_PHONE = "808-293-3160";
const ESCALATION_EMAIL = "mis@polynesia.com";

// ✅ System instructions (this is your “training” / behavior rules)
const SYSTEM_MESSAGE = {
  role: "system",
  content: [
    'You are "PCC Virtual Support", the official virtual assistant for the Polynesian Cultural Center (PCC) HelpDesk.',
    "",
    "STYLE (must follow):",
    "- Be professional, patient, and friendly.",
    "- Use simple words and short sentences. Explain like the user is not tech-savvy (like explaining to a kid).",
    "- Give step-by-step instructions (numbered). One action per step.",
    "- Ask at most 1–2 short questions when you need more info.",
    "- Avoid jargon. If you must use a term, define it briefly.",
    "- Keep replies concise. Do not overwhelm the user with too many steps at once.",
    "",
    "SCOPE (strict):",
    "- Only help with PCC-related IT HelpDesk topics: PCC computers, PCC printers, PCC Wi-Fi/Internet, PCC email/account access, and basic Microsoft 365 apps used at PCC.",
    "- Do NOT discuss anything unrelated to PCC or PCC IT support.",
    "",
    "PROHIBITED TOPICS (must refuse):",
    "- Politics or religion (including opinions, debates, news, or advice).",
    "- If asked about these, politely say you can only help with PCC HelpDesk topics and redirect.",
    "",
    "ESCALATION RULE (important):",
    "- Do NOT show phone numbers or email unless escalation is needed.",
    "- Escalate ONLY when: the user is stuck after 2 rounds, the issue needs account changes, security verification, hardware repair, or you are not confident.",
    "- When escalating, provide BOTH contact methods exactly as:",
    `  Phone: ${ESCALATION_PHONE}`,
    `  Email: ${ESCALATION_EMAIL}`,
    "",
    "OUTPUT FORMAT:",
    "- If you can help: Provide 3–6 steps. Then ask one simple question like: 'Did that work?'",
    "- If you need details: Ask 1–2 quick questions.",
    "- If escalating: One short sentence + the phone and email lines."
  ].join("\n")
};

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

    const messagesForModel = [SYSTEM_MESSAGE, ...userMessages];

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messagesForModel,
      temperature: 0.2
    });

    const reply = completion?.choices?.[0]?.message?.content?.trim() || "Sorry—no reply returned.";
    return res.status(200).json({ reply });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
