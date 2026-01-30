import OpenAI from "openai";

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

  // Look at last ~10 history entries for context (user + assistant)
  const recent = Array.isArray(history) ? history.slice(-10) : [];
  const historyText = recent
    .map((h) => (h && typeof h.content === "string" ? h.content : ""))
    .join(" ");

  return isHelpdeskTopic(historyText);
}

/**
 * Keep history only in a safe format (role/content) and cap size
 * to avoid huge payloads.
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

  // cap to last 20 turns
  return cleaned.slice(-20);
}

export default async function handler(req, res) {
  // CORS (okay for testing; tighten later)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { message, history = [] } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required" });
    }

    const safeHistory = normalizeHistory(history);

    // ✅ FIX: scope check uses message OR history context
    if (!isInScope(message, safeHistory)) {
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
        { role: "user", content: message }
      ],
      max_output_tokens: 300
    });

    return res.status(200).json({ text: response.output_text });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      text:
        "Sorry — something went wrong on our side.\n" +
        "Please contact the PCC HelpDesk at 808-293-3160."
    });
  }
}
