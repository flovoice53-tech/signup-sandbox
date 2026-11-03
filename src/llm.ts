// Chat completions on Vultr Serverless Inference (OpenAI-compatible API).
// LLM_BASE_URL can point at any compatible endpoint for local development.
const BASE_URL = process.env.LLM_BASE_URL ?? "https://api.vultrinference.com/v1";
export const MODEL = process.env.LLM_MODEL ?? "";
// Send page screenshots too, for models that accept images.
export const VISION = process.env.LLM_VISION === "1";

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string | Part[] };

export type Usage = { promptTokens: number; completionTokens: number };

let lastCall = 0;

export async function chat(messages: ChatMessage[], maxTokens?: number): Promise<{ text: string; usage: Usage }> {
  if (!process.env.LLM_API_KEY || !MODEL) throw new Error("LLM_API_KEY and LLM_MODEL must be set");
  // Optional spacing between calls, for free-tier endpoints with a per-minute cap.
  const wait = lastCall + Number(process.env.LLM_MIN_INTERVAL_MS ?? 0) - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  let res: Response | null = null;
  // Rate limits and overloads are usually gone a few seconds later.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    try {
      res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.LLM_API_KEY}` },
        body: JSON.stringify({ model: MODEL, messages, temperature: 0, max_tokens: maxTokens ?? Number(process.env.LLM_MAX_TOKENS ?? 3000) }),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (err) {
      // Network error or timeout: retry, unless this was the last attempt.
      if (attempt === 3) throw new Error(`LLM request failed: ${(err as Error).message}`);
      continue;
    }
    if (res.status !== 429 && res.status < 500) break;
  }
  if (!res) throw new Error("LLM request failed");
  if (!res!.ok) throw new Error(`LLM ${res!.status}: ${(await res!.text()).slice(0, 300)}`);
  res = res!;
  const data = (await res.json()) as {
    choices: { message: { content: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: data.choices[0]?.message.content ?? "",
    usage: { promptTokens: data.usage?.prompt_tokens ?? 0, completionTokens: data.usage?.completion_tokens ?? 0 },
  };
}

// Models sometimes wrap JSON in prose or a code fence; take the outermost object.
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
