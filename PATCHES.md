# Local hotfixes carried by this branch

`browser-hotfixes` is upstream `main` plus the fixes below. Each one exists because
the corresponding upstream behavior fails on a real account or rollout; they are kept
as source edits so they survive rebuilds and upstream version bumps.

| Fix | File(s) | Why |
| --- | --- | --- |
| Chat/Work switcher recognition | `src/browser/actions/navigation.ts` | The switcher now renders as `button[aria-pressed]` with localized labels (e.g. `聊天` / `工作`) instead of `button[role="radio"]` with English text. The probe also refuses a rendered switcher that is stuck on Work, because Work mode consumes Codex quota and uses a different composer DOM. |
| Chat mode verification window | `src/browser/actions/navigation.ts` | A cold seeded profile needs ~65s to render the switcher; upstream caps the window at 10s. A real window is floored at 120s and capped at 180s; an explicit zero still fails fast. |
| Switch retry | `src/browser/actions/navigation.ts` | A trusted click is swallowed while the app hydrates. The switch retries (throttled, capped) and falls back to a DOM click on the same button. |
| Login probe timeout | `src/browser/actions/navigation.ts` | A 5s auth probe times out before a cold copied profile finishes hydrating; 30s keeps authentication mandatory but bounded. |
| Model label tokenization | `src/browser/actions/modelSelection.ts` | Concatenated picker labels (`SolLight`) were read as `Sol`. Labels are split before tokenizing, and a Light result no longer satisfies a Sol request. |
| Live stall threshold | `src/cli/browserTabs.ts` | Reasoning models can go minutes without emitting text, so the 60s `--live`/`--harvest` stall exit fired mid-generation; raised to 600s. |
| Browser timeout floor | `src/cli/browserConfig.ts` | A `--browser-timeout` smaller than the overall `--timeout` truncated long generations; the browser wait is now at least the task budget. |

## Gemini 4 Argon

`gemini-4-argon`, `gemini-4-argon-thinking` (High) and
`gemini-4-argon-thinking-medium` are supported on the cookie-based Gemini web path
and mapped to `gemini-4-argon` for the API engine. The web header uses the model
hash `95a4c0abcba24364` with model code `8` and thinking codes `1` / `2` / `4`.
Argon needs an account whose Gemini picker offers it; other accounts are downgraded
to Flash-Lite by Google.
