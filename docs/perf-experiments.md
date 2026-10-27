# Performance experiments log

Every latency experiment on fx0's prompt path is recorded here: hypothesis, change, security review, measured result, and decision. Measurements come from `npm run perf:lab` (see [performance.md](performance.md)). Raw runs and HTML reports stay local under `.next/fx0-lab/<experiment>/`. They are not committed.

## Ground rules

- **Security is not traded for speed.** Every change keeps authentication, revocation, ownership, same-origin checks, funding-before-admission, idempotency, and durability exactly as strong as before. A candidate that weakens any of them is rejected regardless of its gain.
- One hypothesis per experiment. Span-level traces attribute each part when one candidate carries two independent changes.
- Paired A/B with balanced, seeded order, equal instrumentation, and the same account, team, model settings, workload, and environment. Failures are kept, never retried.
- An A/A control measures noise first. Effects smaller than that noise are reported as "not detected", not as gains.
- Local caveat: `next dev` on a laptop talks to remote Redis and Neon, so database-bound stages are larger than on Vercel (iad1). Prefer relative, same-environment comparisons, and confirm on a preview before claiming production impact.

## Baseline anatomy (local-development, warm, "Reply exactly OK. Do not use tools.")

Medians from 4 warm prompts on 2026-10-27, server clock relative to the start of the request handler:

| Stage | Start | Duration |
| --- | ---: | ---: |
| `request.auth` (cookies, revocation check) | 0 | ~155 ms |
| auth → journal gap (route checks, ownership) | | ~195 ms (varies 190–900 ms) |
| `prompt.journal` | ~350 | ~160 ms |
| `prompt.credential` (save turn funding) | ~515 | ~330 ms |
| `prompt.hydrate` | ~850 | ~165 ms |
| `prompt.bind` (libfx session) | ~1010 | ~185 ms |
| `prompt.accepted` (libfx admission) | ~1195 | ~10 ms |
| wait for first journal read before headers | | ~170 ms |
| `model.prepare` (funding, draft observer, step budget) | | ~560 ms |
| `model.headers` (AI Gateway until response headers) | | ~880 ms |

Browser: Sending (POST → headers) ≈ 1.39 s; first text ≈ 3.4–4.2 s.

## Noise: A/A control

`aa-smoke`, 2 pairs, same source both sides: Sending paired Δ −0.3 ms; first text paired Δ −226 ms. Sending is stable. First text is dominated by model-side variance (±300 ms per prompt), so it needs ~10+ pairs to detect effects below ~200 ms.

## Experiment 1: early headers + parallel funding save

- **Date:** 2026-10-27. **Lab:** `.next/fx0-lab/early-ack`. **Branch (local):** `esteban/fx0-perf-early-ack`.
- **Hypothesis A:** response headers wait for the first journal read (~170 ms). The trace confirmed this in 4 of 4 prompts: browser POST→headers matched handler start→first SSE delivery within 7 ms. Writing an SSE comment frame when the stream opens sends the headers immediately.
- **Hypothesis B:** saving the turn credential (~330 ms) does not depend on hydrating or binding the libfx session (~350 ms), so the two can run together. Both settle before libfx sees the message.
- **Change:** `lib/event-stream.ts` sends `: open` on start; `lib/agent.ts` runs credential save and hydrate→bind with `Promise.all`, then admits. Tests: the stream opens before any journal read finishes; the funding record is saved before libfx sees the message even while the session is prepared alongside it; a failed credential save stops the prompt before libfx.
- **Security review:**
  - The comment frame is written only after the route returns its `Response`, which happens after auth, revocation, same-origin, ownership, funding, and admission have all completed. Rotated cookies are still appended to the same headers. Clients already ignore comment frames (the 15 s heartbeat uses one).
  - Funding-before-admission is unchanged and now has a regression test. If the credential save fails after the session is bound, the result is a bound libfx session with no message. That is the same state a new chat reaches when a later step fails, and it grants nothing.
  - No credential, token, or ownership check is skipped, cached, or reordered after a write.
- **Result:** 10 valid pairs, compatible, 0 failures.

  | Metric (paired median) | Δ |
  | --- | ---: |
  | Sending | **−333 ms (23 %)** |
  | Server admission end | −99 ms |
  | First text | −28 ms (not detected; noise ±200 ms) |

- **Attribution from spans:** early headers reduced handler-end→headers from ~190 ms to ~8 ms in every candidate run. Parallel save cut the handler by ~330 ms when the save took its usual time. In 3 of 10 runs the save itself slowed to 514–713 ms under concurrency, which absorbed the gain.
- **Decision:** keep early headers (consistent, no security impact). Keep parallel save provisionally: a small median gain with variance. Re-test it on a Vercel preview, where database round trips are shorter, before deciding.

## Finding: the local handler is a chain of ~7 serial round trips

Added measurement-only spans `request.revocation`, `request.owner`, and `prompt.activate` (2026-10-27, lab `gap-probe`, 4 warm prompts). The auth → journal gap is now fully explained:

| Stage | Duration | Round trips |
| --- | ---: | --- |
| `request.revocation` (nearly all of `request.auth`) | ~160 ms | 1 Redis GET |
| `request.owner` | 175–210 ms | 1 Neon query |
| `prompt.journal` | ~170 ms | 1 Redis script |
| `prompt.credential` | ~330 ms | 2: revocation GET, then write pipeline |
| `prompt.hydrate` | ~165 ms | 1 Redis read |
| `prompt.bind` | ~165 ms | 1 Redis write (new chat) |

Each round trip from this laptop to Redis/Neon in iad1 costs ~160 ms, so the local lab inflates database-bound stages by an order of magnitude compared with Vercel. **What transfers to production is the count of serial round trips, not the local milliseconds.** Production Sending is instead dominated by libfx's Vercel admission: 465–1070 ms in earlier preview logs, including the queue backstop. Local file durability hides that (~10 ms locally).

Two more observations:

- The headless driver types and presses Enter immediately. The draft reservation (`POST /api/sessions`) and the typing warm-up (`POST /api/warm`) therefore race the prompt in the same process. Real users usually type for seconds first, so local runs include contention that real sends mostly avoid. This is equal on both A/B sides, but it inflates variance.
- The server trace recorder lives in a process global and keeps its allowlist across hot reloads. **Restart `next dev` after adding trace names**, or new spans are silently dropped.

## Production-like anatomy (vercel-preview, warm)

Preview `fx0-git-esteban-fx0-request-tracing.labs.vercel.dev`, commit `d5b8bc7`, tracing enabled only for that branch through `FX0_TRACE_PREVIEW=1`. Lab `preview-aa`: 6 warm prompts in 3 A/A pairs, plus 1 excluded cold sample. Medians:

| Stage | Median | Note |
| --- | ---: | --- |
| `request.revocation` | 4 ms | |
| `request.owner` | 14 ms | |
| `prompt.journal` + `credential` + `hydrate` + `bind` | ~25 ms | `bind` was 326 ms once (cold libfx backend) |
| **`prompt.accepted` (libfx Vercel admission)** | **549 ms** | **92 % of the handler** |
| Handler total | 599 ms | |
| Outside the handler (browser ↔ Vercel network) | ~320 ms | Sending minus handler |
| **Sending** | **849 ms** | |
| Accepted → `model.prepare` start (libfx turn start in the request) | ~196 ms | |
| `model.prepare` | 17 ms | |
| `model.headers` (AI Gateway TTFB) | ~741 ms | Once 1.5 s |
| **First text** | **2.55 s** | Local was 3.4–4.2 s |

The cold first sample took 2.59 s Sending: `prompt.bind` 453 ms and `prompt.accepted` 1124 ms.

**Correction to Experiment 1:** in production, fx0's own database stages total ~45 ms, so early headers save ~18 ms and the parallel credential save at most ~10 ms. The local −333 ms came from laptop-to-iad1 round trips and does not transfer. The real targets are libfx admission (549 ms), libfx turn start (~196 ms), and model TTFB (~741 ms).

To see inside admission, the server recorder now also observes every undici request through `diagnostics_channel`, including the copy bundled into libfx's Vercel World. It records only a fixed category (`net.workflow`, `net.queue`, `net.oidc`, `net.vercel_api`, `net.redis`, `net.neon`, `net.gateway`, `net.other`), the status, and the time to response headers. It never records the URL, path, headers or body. It only runs when tracing is enabled, and never in production.

## Inside libfx admission (vercel-preview, network spans)

Lab `preview-net`, commit `9a418d1`, 4 warm prompts to new chats. `prompt.accepted` took 377–534 ms (Sending 605–771 ms; first text 1.82–2.09 s). Its network calls are the same in every run, and all serial:

| # | Call | Status | Duration |
| --- | --- | --- | ---: |
| 1 | Session log length (`log.ui.length()`) | 404 | 43–114 ms |
| 2 | Session log read, twice in parallel (caller's `log.read()` and the one inside `send()`) | 404, 404 | 40–60 ms |
| 3–5 | Three Workflow writes (message record and seeding) | 200 | 49–62, 55–92, 72–186 ms |
| 6 | Vercel Queues backstop | 201 | 49–84 ms |

Reading `libfx` 0.0.14 `durable.js` (`startTurn` / `send`) explains this. fx0 passes an explicit `messageId` so a retried send cannot duplicate the message, which takes the idempotent path: read the log length, then read the log while `send()` opens the session, reads the log again, records the message, and sends the queue backstop. Then `turn.accepted` resolves.

- Calls 1–2 read a session that this same request just created with `newSessionId()`. For a chat's first message they cannot find anything (404 every time). That is ~100–170 ms of serial reads with no information.
- Recording the message and creating the backstop before acknowledging are durability contracts (no accepted message may be lost if the function dies). They stay.
- The three writes are serial; whether any can be combined without losing atomicity is a libfx question.
- After admission, the turn starts in the same request: Redis/Neon funding reads (~10 ms) and more Workflow writes (100–460 ms, partly in parallel), then `model.prepare` and the Gateway call.

Host `vercel-workflow.com` was initially classified `net.other`. It is now `net.workflow`.

## Candidate ideas

| Idea | Expected effect | Security assessment | Status |
| --- | --- | --- | --- |
| Early headers (comment frame) | Sending −170 ms | Safe: after all checks | Done (Exp. 1) |
| Parallel credential save + session prep | Sending −100…330 ms | Safe: funding still precedes admission | Done (Exp. 1), re-test on preview |
| Cache funding in memory for `model.prepare` | First text −100+ ms | **Rejected:** sign-out must stop the next model step through the authoritative funding read; a cache could keep billing a revoked login | Rejected |
| Skip ownership query for repeat prompts | Sending −150 ms | Already done safely in-process when the runtime is bound to the same user; widening it (e.g. to a cookie hint) would trust client state | Keep as is |
| Decompose auth → journal gap | Explained | Measurement only | Done |
| Atomic credential store: revocation check + writes in one Lua script | −1 round trip on admission | **Stronger than today:** removes the window between the revocation check and the write | Proposed |
| Funding read for each model step in one round trip (credential + revocation) | −1 round trip per model step, on the first-text path | Same authoritative read and revocation check, from one consistent snapshot | Proposed |
| Return session state from the journal script (journal + hydrate) | −1 round trip on admission | Same owner-checked chat and data; no new trust | Proposed |
| Run revocation and ownership reads together, act only after both pass | −1 round trip on every chat route | Reads only; nothing is written or returned before both checks pass | Proposed |
| Measure on a Vercel preview with `FX0_TRACE_PREVIEW=1` | Real production anatomy | Tracing stays off in production by code | Done |
| Decompose libfx admission (549 ms) with network spans | Found 6 serial calls | Measurement only | Done |
| libfx: skip the pre-reads for a session created in the same request | Sending −100…170 ms on a chat's first message | Same idempotency: a session id generated in this request cannot hold a prior message. Needs a libfx API signal (e.g. `fresh`) and libfx owner review | Proposed (libfx) |
| libfx: combine the serial admission writes | Sending −50…150 ms | Only if the message record stays atomic and precedes the backstop | Investigate (libfx) |
| fx0: drop the explicit `messageId` | Faster admission path | **Rejected:** a retried send could duplicate the message | Rejected |
