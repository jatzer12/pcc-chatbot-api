import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ALLOWED_ORIGIN = "https://jatzer12.github.io"; // your GitHub Pages origin

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
    const messages = Array.isArray(body.messages) ? body.messages : null;
    const message = typeof body.message === "string" ? body.message : "";

    // Prefer full history
    const inputMessages = (messages && messages.length)
      ? messages
      : [
          {
            role: "system",
            content:
              "You are the Polynesian Cultural Center (PCC) HelpDesk Assistant. " +
              "You only assist with PCC IT issues: computers, printers, Wi-Fi/internet, email/account access, and basic Microsoft 365 apps. " +
              "Ask 1–2 clarifying questions when needed. Provide step-by-step instructions. " +
              "If the user still cannot resolve it, advise contacting PCC HelpDesk at 808-293-3160."
          },
          { role: "user", content: message }
        ];

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: inputMessages,
      temperature: 0.2
    });

    const reply = completion?.choices?.[0]?.message?.content?.trim() || "Sorry—no reply returned.";
    return res.status(200).json({ reply });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
