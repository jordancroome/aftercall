import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

/** One prompt in, the text of the reply out. */
export async function ask(prompt: string, maxTokens: number): Promise<string> {
  client ??= new Anthropic();
  const res = await client.messages.create({
    model: process.env.AFTERCALL_MODEL || "claude-sonnet-5-5",
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  return res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
}
