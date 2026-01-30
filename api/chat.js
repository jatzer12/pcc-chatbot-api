import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Restrict topics to PCC HelpDesk scope
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
  /* =========================
     CORS (MUST BE FIRST)
     ========================= */
  res.setHeader(
    "Access-Control-Allow-Origin",
    "https://jatzter12.github.io"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  // Handle preflight request
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const { message, history = [] } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        error: "Message is required"
      });
    }

    // Hard topic restriction
    if (!isHelpdeskTopic(message)) {
      return res.json({
        text:
          "I can assist with PCC HelpDesk issues only (computer, printer, Wi-Fi, and basic account access). " +
          "For other concerns, please contact the PCC HelpDesk at 808-293-3160."
      });
    }

    const systemPrompt = `
You are the Polynesian Cultural Center HelpDesk virtual assistant.

Scope:
- Computer, printer, Wi-Fi / internet, and basic account access issues.

Rules:
- Provide clear, step-by-step troubleshooting.
- Never ask for passwords or MFA codes.
- Keep responses concise and practical.
- If the issue requires hands-on support or you are unsure, escalate.

Escalation:
PCC HelpDesk
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

    return res.status(200).json({
      text: response.output_text
    });
  } catch (err) {
    console.error("API error:", err);
    return res.status(500).json({
      error: "Internal server error"
    });
  }
}
