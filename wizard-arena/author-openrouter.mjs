// Forge a new LLM-authored wizard via OpenRouter (works with any model there).
//
//   export OPENROUTER_API_KEY=sk-or-...
//   node author-openrouter.mjs --style "a paranoid lightning hermit" \
//        --model openai/gpt-4o --out wizards/ember.js
//   node author-openrouter.mjs --style "a greedy void cultist" \
//        --model google/gemini-2.5-pro --out wizards/frost.js
//
// No SDK needed — plain fetch against OpenRouter's OpenAI-compatible API.
// Pit different models against each other by forging each slot with a
// different --model.

import {
  SYSTEM_PROMPT, RULEBOOK, parseArgs, extractJSON, saveWizard, summarize,
} from "./forge-common.mjs";

const args = parseArgs(process.argv.slice(2));
const style = args.style || "surprise me — invent a distinctive archetype";
const out = args.out || "wizards/challenger.js";
const model = args.model || "openrouter/auto";

const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error("Set OPENROUTER_API_KEY (get one at https://openrouter.ai/keys).");
  process.exit(1);
}

console.log(`Forging a wizard via ${model} (${style}) …`);

const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://localhost/wizard-arena",
    "X-Title": "Arcanum Field wizard forge",
  },
  body: JSON.stringify({
    model,
    max_tokens: 8000,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `${RULEBOOK}\n\nDesign brief for YOUR wizard: ${style}\n\n` +
          `Respond with ONLY a JSON object of this exact shape (no prose, no markdown fences):\n` +
          `{"name": "...", "epithet": "...", "color": "#rrggbb", "color2": "#rrggbb",\n` +
          ` "element": "fire|water|earth|air|light|dark",\n` +
          ` "spells": [{"name": "...", "desc": "...", "element": "...", "incantation": "<JS code>"}],\n` +
          ` "policy": "<JS code>"}`,
      },
    ],
  }),
});

if (!res.ok) {
  console.error(`OpenRouter error ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const data = await res.json();
if (data.error) {
  console.error(`OpenRouter error: ${data.error.message || JSON.stringify(data.error)}`);
  process.exit(1);
}
const text = data.choices?.[0]?.message?.content ?? "";
let wiz;
try {
  wiz = extractJSON(text);
} catch (e) {
  console.error(`Could not parse the model's reply (${e.message}). Raw reply:\n${text}`);
  process.exit(1);
}

saveWizard(wiz, out, data.model || model, style);
summarize(wiz, out);
