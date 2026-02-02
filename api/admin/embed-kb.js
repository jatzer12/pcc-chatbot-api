import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Server-only Supabase client (admin)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Simple protection so this endpoint cannot be abused
const ADMIN_SECRET = process.env.ADMIN_SECRET;

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "POST only" });
    }

    const secret = req.headers["x-admin-secret"];
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 1) Get KB rows missing embeddings
    const { data: rows, error: fetchError } = await supabaseAdmin
      .from("kb_chunks")
      .select("id, content")
      .is("embedding", null)
      .limit(50);

    if (fetchError) throw fetchError;

    if (!rows || rows.length === 0) {
      return res.status(200).json({
        message: "No rows need embedding. All good."
      });
    }

    // 2) Create embeddings using OpenAI
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: rows.map(r => r.content)
    });

    // 3) Save embeddings back to Supabase
    const updates = rows.map((row, index) => ({
      id: row.id,
      embedding: embeddingResponse.data[index].embedding
    }));

    const { error: updateError } = await supabaseAdmin
      .from("kb_chunks")
      .upsert(updates, { onConflict: "id" });

    if (updateError) throw updateError;

    return res.status(200).json({
      success: true,
      embedded_rows: updates.length
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: err.message || "Embedding failed"
    });
  }
}
