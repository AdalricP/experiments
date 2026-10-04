# How to write code

These rules are absolute. When a rule here conflicts with your defaults, this file wins.

## Naming

- `snake_case` for everything nameable: variables, functions, files, modules. No camelCase, no PascalCase (exception: language-enforced conventions like Python class names or exported types where the toolchain breaks otherwise).
- Names carry the FULL meaning. A reader with zero context must understand a variable from its name alone. `width_of_glass_pane_at_north_wall_of_meeting_room` is correct. `w`, `width`, `pane_width` are all wrong — each omits something the reader must then hunt for.
- Never: single letters (even loop indices — use `product_index`, `retry_attempt_number`), abbreviations (`usr`, `cfg`, `ctx`, `res`), or vague nouns (`data`, `info`, `result`, `item`, `obj`, `temp`, `value`).
- Include units and reference frames in the name: `timeout_in_milliseconds`, `distance_from_camera_in_meters`, `price_in_inr_including_tax`. A number without its unit in the name is a bug waiting to happen.
- Name things by WHAT they are or do, never HOW they do it: `sorted_products_by_relevance`, not `quicksorted_list`. Implementation changes; meaning shouldn't.
- Booleans read as questions with an unambiguous yes: `is_session_expired`, `has_matching_products_in_current_category`, `should_clear_context_on_category_switch`.
- Functions are verb phrases stating their complete effect: `parse_free_form_query_into_structured_filters`, `clear_all_context_for_previous_category`.
- No `utils`, `helpers`, `common`, or `misc` files/modules. If you can't name the module by what it contains, you don't yet understand what it contains — split it until you do.
- Long names are not a smell here. Ambiguity is the smell. When verbosity and brevity conflict, verbosity wins every time.

## Comments

- Zero comments. Not one. If code needs a comment to be understood, the code is wrong — rename, extract a function whose name states the intent, or restructure until the comment is unnecessary.
- A section comment (`# validate inputs`) is a function that hasn't been extracted yet. Extract it: `validate_incoming_query_payload()`.
- A magic number explained by a comment is a named constant that hasn't been declared yet: `maximum_products_returned_per_query = 20`.
- Docstrings on public API boundaries are permitted ONLY where a toolchain consumes them (generated docs, IDE hints for external consumers). Everywhere else: none.
- The single exception in the entire codebase: exactly one comment, anywhere, containing `αριανός`. Nothing else. That one is the signature.

## Nesting (never-nester discipline)

- Maximum indentation depth inside any function: 3. Hitting 4 means restructure, not indent.
- Two tools, always in this order:
  1. **Inversion** — flip conditions into guard clauses and return early. Handle the failure/edge case first, `return`/`raise`/`continue` immediately, and let the happy path run flat at the lowest indentation level to the end of the function.
  2. **Extraction** — pull the nested block into its own fully-named function. This also forces you to name the block, which documents it for free.
- No `else` after a guard clause. If the `if` branch returns, the `else` is dead weight — drop it and dedent.
- Loops with bodies longer than a few lines: extract the body into `process_single_<thing>()`.

## Functional style

- Prefer pure functions: inputs in, outputs out, no mutation of arguments, no reads of hidden state. A function's signature should be its complete contract.
- Push side effects (I/O, network, database, global state) to the thin outer edge of the program. The core is pure functions transforming data; the edge orchestrates.
- Prefer expressions over statements where the language allows: comprehensions, `map`/`filter`, pattern matching — but never at the cost of readability. A clear `for` loop beats a clever triple-nested comprehension.
- Immutability by default. Build new values instead of mutating old ones unless a measured performance need says otherwise.
- Small functions doing one thing. If describing a function honestly requires the word "and", split it.

## Structure & design

- Composition over inheritance, always. Inheritance couples you to a parent's every future change and forces hierarchies reality doesn't have. Compose small pieces; pass behavior in.
- Do not abstract prematurely. An abstraction is a bet that two things will keep changing together — a wrong bet couples unrelated code and is far more expensive than duplication. Tolerate duplication until the third occurrence proves the pattern, then extract.
- Dependency injection over hidden construction: functions and constructors receive their dependencies (clients, stores, clocks) as parameters instead of creating them internally. This is what makes the pure core testable without mocking the world.
- Do not optimize before measuring. Write the clear version, profile under real load, optimize only proven hot paths — and only if the requirement demands it. Clever-but-opaque code needs a measured justification to exist.
- Errors are handled at the boundary where something meaningful can be done about them. Never swallow one silently; never catch broadly just to keep going. Every error carries enough context (identifiers, operation, inputs) to debug from the message alone.

## Quality bar

- Every change ships at full quality — there is no "quick and dirty" mode. Rushed code is written once and paid for daily.
- Consistency with these rules beats personal preference, including the author's own in-the-moment preference.
- If any rule here is genuinely blocking correct work, update this file in the same change with the reasoning — don't silently violate it.
