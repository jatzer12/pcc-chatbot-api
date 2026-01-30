import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Simple allowlist: keeps the bot focused on PCC Helpdesk topics
function isHelpdeskTopic(text = "") {
  const t = text.toLowerCase();
  return [
    "computer", "pc", "laptop",
    "printer", "printing",
    "wifi", "wi-fi", "internet", "network",
    "email", "outlook",
    "password", "login", "mfa",
    "windows", "monitor", "keyboard", "mouse",
    "teams", "onedrive"
  ].some(k => t.includes(k));
}

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { message, history = [] } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required" });
    }

    // Hard restriction (code-level)
    if (!isHelpdeskTopic(message)) {
      return res.json({
        text:
          "I can assist with PCC Helpdesk issues only (computer, printer, Wi-Fi/internet, and basic account access). " +
          "For other concerns, please contact the PCC Helpdesk at 808-293-3160."
      });
    }

    // Policy / restrictions (prompt-level)
    const systemPrompt = `
You are the Polynesian Cultural Center HelpDesk virtual assistant.

Scope:
- Computer, printer, Wi-Fi/internet, and basic account access issues.

Rules:
- Give clear, step-by-step instructions.
- Keep responses concise.
- Never request passwords or MFA codes.
- If the issue requires hands-on support or you are unsure, escalate.

Escalation:
PCC Helpdesk
Phone: 808-293-3160
Email: helpdesk@pcc.edu
`;

    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: message }
      ],
      max_output_tokens: 300
    });

    return res.json({ text: response.output_text });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
