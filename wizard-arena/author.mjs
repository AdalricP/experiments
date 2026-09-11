// Forge a new LLM-authored wizard via the Anthropic API.
// NOTE: this needs API credits from platform.claude.com — a Claude.ai
// subscription does NOT include API access. No API key? Use
// author-openrouter.mjs instead (works with any OpenRouter model).
//
//   npm install
//   node author.mjs --style "a paranoid lightning hermit" --out wizards/ember.js
//
// Auth: ANTHROPIC_API_KEY, or an `ant auth login` profile if present.

import Anthropic from "@anthropic-ai/sdk";
import {
  SYSTEM_PROMPT, RULEBOOK, WIZARD_SCHEMA, parseArgs, saveWizard, summarize,
} from "./forge-common.mjs";

const args = parseArgs(process.argv.slice(2));
const style = args.style || "surprise me — invent a distinctive archetype";
const out = args.out || "wizards/challenger.js";

const client = new Anthropic();

console.log(`Forging a wizard (${style}) …`);
const stream = client.messages.stream({
  model: "claude-opus-5",
  max_tokens: 16000,
  system: SYSTEM_PROMPT,
  output_config: { format: { type: "json_schema", schema: WIZARD_SCHEMA } },
  messages: [{
    role: "user",
    content: `${RULEBOOK}\n\nDesign brief for YOUR wizard: ${style}\n\nRespond with the wizard JSON only.`,
  }],
});
stream.on("text", () => process.stdout.write("."));
const msg = await stream.finalMessage();

if (msg.stop_reason === "refusal") {
  console.error("\nThe model declined this brief — try a different --style.");
  process.exit(1);
}
const text = msg.content.find((b) => b.type === "text")?.text ?? "";
const wiz = JSON.parse(text);

saveWizard(wiz, out, msg.model, style);
summarize(wiz, out);
