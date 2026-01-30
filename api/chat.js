import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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

export default function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.json({ error: "Method not allowed" });
  }

  (async () => {
    try {
      const { message, history = [] } = req.body || {};

      if (!message) {
        res.statusCode = 400;
        return res.json({ error: "Message is required" });
      }

      if (!isHelpdeskTopic(message)) {
        return res.json({
          text:
            "I can assist with PCC Helpdesk issues only (computer, printer, Wi-Fi, and account access). " +
            "For other concerns, please contact the PCC Helpdesk at 808-293-3160."
        });
      }

      const systemPrompt = `
You are the Polynesian Cultural Center HelpDesk virtual assistant.

Rules:
- PCC IT issues only
- Step-by-step answers
- Never as
