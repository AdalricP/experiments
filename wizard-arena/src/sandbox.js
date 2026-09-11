// Very small "sandbox" for LLM-authored code. This is a local toy — the goal
// is fairness and crash-safety, not real security. Loops get a guard injected
// so a runaway incantation throws instead of freezing the tab.

const LOOP_RE = /\b(for|while)\s*(\([^)]*\))\s*\{/g;

function guardLoops(src, guardName) {
  return src.replace(LOOP_RE, (m, kw, head) =>
    `${kw} ${head} { if(${guardName}()) throw new Error("loop limit"); `);
}

export function compile(src, argNames, guardBudget = 20000) {
  const guarded = guardLoops(src, "__guard");
  let fn;
  try {
    fn = new Function("__guard", ...argNames, `"use strict";\n${guarded}`);
  } catch (e) {
    return { error: `syntax error: ${e.message}`, run: null };
  }
  return {
    error: null,
    run(...args) {
      let n = 0;
      const guard = () => ++n > guardBudget;
      return fn(guard, ...args);
    },
  };
}
