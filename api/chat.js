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
  // ✅ CORS (allow GitHub Pages / browser requests)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // ✅ Handle CORS preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Only allow POST
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

      // ... keep the rest of your existing logic unchanged

      const systemPrompt = `
You are the Polynesian Cultural Center HelpDesk virtual assistant.

Rules:
- PCC IT issues only
- Step-by-step answers
- Never as
