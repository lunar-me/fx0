# Opt-in performance traces

Run fx0 with tracing enabled to measure prompt admission, model transport, tools, journal projection, SSE delivery, and preview updates. Tracing uses no external collector or additional dependencies.

## Record a session

From the repository root, with your development services configured:

```sh
FX0_TRACE=1 npm run dev
```

If your local development environment was pulled from Vercel, use `VERCEL= VERCEL_ENV=development FX0_TRACE=1 npm run dev`. Clear the deployment marker and production environment designation only for a local command against development services. Do not clear them on a deployment.

Open the app on `localhost` or a loopback IP. Send a prompt, wait for its preview, and make a follow-up edit. The server writes batches every 250 ms to `.next/fx0-traces/server-<pid>.jsonl`. This directory is ignored by git. Writes are best-effort and do not block prompt acknowledgement.

In the browser console, download the browser events:

```js
window.__fx0Trace.download()
```

You can also inspect `window.__fx0Trace.snapshot()` or start a fresh browser capture with `window.__fx0Trace.clear()`. Each recorder keeps at most 10,000 completed events; its export reports how many older events it dropped. Server files accumulate across runs, so use files from the run you want to compare. Abrupt shutdown can lose the last unflushed server batch, and unfinished spans are not exported.

Tracing is off unless explicitly enabled. Local tracing uses `FX0_TRACE=1` without `VERCEL`, and its browser scope is loopback-only. Production deployments stay off even if flags are set. To measure a local production build against development services, enable the local flag at both build time and runtime because Next.js embeds the browser flag:

```sh
FX0_TRACE=1 npm run build
FX0_TRACE=1 npm start
```

Local tracing does not make Redis, Neon, or AI Gateway local. Use development services and a separate Redis prefix as described in the setup instructions. Live prompts still incur model charges.

## Record an explicitly enabled preview

For a dedicated Vercel preview, set `FX0_TRACE_PREVIEW=1` for that branch at build time and runtime. Recording additionally requires `VERCEL_ENV=preview` and the Vercel deployment marker. `FX0_TRACE=1` alone never enables a deployment, and production stays disabled.

The build embeds `NEXT_PUBLIC_FX0_TRACE=1` and `NEXT_PUBLIC_FX0_TRACE_SCOPE=preview` only in that opted-in preview. Browser recording accepts fx0 preview hosts under `.labs.vercel.dev` or `.vercel.app`; unknown scopes and other hosts stay off.

Each Vercel function exports its own completed spans as bounded, allowlisted JSON records tagged `fx0:trace`. There are no preview filesystem writes and no new trace endpoint. Exported lanes use random per-process identifiers, not a shared-process assumption between routes. Console logging has overhead: compare variants with the same instrumentation, and do not assume an instrumented latency is identical to tracing-off production.

Collect a deployment-scoped log export with your authorized Vercel CLI session:

```sh
vercel logs --scope vercel-labs --project fx0 \
  --deployment "$PREVIEW_URL" --environment preview --since 1h \
  --query '\"fx0:trace\"' --json --non-interactive > /tmp/fx0-preview-server.jsonl
node scripts/trace-report.mjs /tmp/fx0-preview-server.jsonl /path/to/fx0-browser-trace.json
```

The report accepts both native trace files and Vercel log wrappers, deduplicating repeated exported batches. An empty log is not a successful measurement. A span missing from the export is unknown, not zero; drops and unfinished spans invalidate an exhaustive breakdown.

Use the actual preview UI and its existing authentication. No cookies need to be copied. The recorder roots start at an accepted send handler, before reservation and thumbnail preparation. `prompt.first_content` means text received by client state application, not painted pixels. Account/bootstrap waits before that handler are not measured by that root.

## Run an end-to-end live prompt

This test drives the actual app UI in Chrome. It sends one real prompt and waits for the journal-backed end of its turn and presentation of its final published preview. It does not substitute a model, replay events, or bypass authentication. It can incur model charges and creates a chat/turn. Use development Redis and Neon, the matching local `APP_URL`, and a separate Redis prefix; do not point a performance run at production services.

Start this checkout with tracing enabled:

```sh
VERCEL= VERCEL_ENV=development FX0_TRACE=1 node --run dev
```

In another terminal in the same checkout, run:

```sh
node --run test:perf:e2e -- --url http://localhost:3000
```

The runner uses its own headless Chrome and temporary profile by default, with a 1440 by 1000 CSS-pixel viewport. It never activates or resizes the user's normal Chrome and never copies cookies. If authentication is missing, it exits before sending. Interactive sign-in requires an explicit `--headed` run; no headed window is opened automatically. The total deadline is 180 seconds by default. Set `CHROME_PATH` if needed. This runner remains loopback-only; preview collection above uses the real preview's existing authenticated UI instead.

To choose the prompt or deadline:

```sh
node --run test:perf:e2e -- --url http://localhost:3000 --prompt "Create a static bookshop landing page" --timeout-ms 300000
```

The runner submits through one native CDP Enter keydown/keyup pair, not a button click. It observes that keydown in the browser and reports `enterToMs` for Enter-to-handler, acknowledgement, first text, first HTML, and completion. This is the injected browser input event, not a hardware-key timestamp. The recorder's existing roots and `milestonesMs` still start at the accepted send handler, before reservation and thumbnail preparation. The runner waits for a ready composer, so this controlled workload does not cover an Enter queued while account/chat bootstrap is incomplete.

The browser records:

- `prompt.acknowledged`: the server returned successful prompt response headers.
- `prompt.first_content`: first nonempty assistant text delivered to the UI.
- `prompt.first_draft`: first provisional HTML bytes delivered, not a paint measurement.
- `prompt.finished` and `prompt.turn`: a journaled terminal event, not merely an SSE disconnect.
- `preview.presented`: the final iframe's paint signal followed by the React reveal, removal of the draft overlay, and two animation frames.
- `prompt.e2e`: send through both turn completion and final preview presentation. A text-only turn with no artifact ends at its journaled terminal event.

Disconnecting a stream does not finish a root. Failed, cancelled, evicted, or incomplete captures cannot pass. If the final preview is never presented, the test times out rather than reporting generation time as successful end-to-end completion. A timeout or closing Chrome does not cancel a turn already running on the server; check the chat before sending another prompt.

The runner writes `summary.json` and a browser `trace.json` under a new `.next/fx0-perf/e2e-.../` directory. The summary lists milestone times relative to send and complete browser spans. It does not include the prompt or DOM content. These are browser-side end-to-end durations, including waits for server and model work; they are not a server-stage breakdown. Server spans remain in `.next/fx0-traces/` and can be combined with the browser file using the report command below. Do not sum overlapping spans.

Validate the lifecycle and Chrome driver without a live generation:

```sh
node --run test:trace
node --run test:perf:e2e:driver
```

These checks do not establish a successful live generation. The live runner itself must complete against the authenticated, configured app to obtain that measurement.

## Performance lab: visual traces and A/B

`npm run perf:lab` turns real prompts into self-contained HTML reports, in the spirit of fast-snap's result pages, and runs paired A/B campaigns. Reports are offline files with a per-process waterfall, browser phases, milestones, trace health, and the run's conditions. Each one can download the run JSON and a Chrome trace for Perfetto.

1. Start the app with tracing (`VERCEL= VERCEL_ENV=development FX0_TRACE=1 npm run dev`). `next dev` is required for an `http://localhost` `APP_URL`.
2. Sign in once with a dedicated profile. It opens its own Chrome window and never touches your normal profile:

   ```sh
   npm run perf:lab -- login --profile ~/.fx0-perf-profile --url http://localhost:3000
   ```

3. Capture one live prompt headless. The default workload is `Reply exactly OK. Do not use tools.`:

   ```sh
   npm run perf:lab -- run --profile ~/.fx0-perf-profile --url http://localhost:3000 --out .next/fx0-lab/today
   ```

4. Compare two versions. Run the baseline and candidate checkouts on two ports, each with its own `APP_URL`, so same-origin checks pass. Then:

   ```sh
   npm run perf:lab -- ab --profile ~/.fx0-perf-profile --out .next/fx0-lab/my-change --pairs 6 --seed my-change \
     --baseline-url http://localhost:3000 --baseline-source ../fx0-baseline \
     --candidate-url http://localhost:3001 --candidate-source .
   ```

   The schedule balances A→B and B→A order and is reproducible from the seed. One warmup per side is excluded by default. Failed samples are saved and counted, never retried.

`import` saves an existing browser/server capture. `report LAB` rebuilds `LAB/index.html`. `schedule` prints an order without sending anything.

The comparison refuses to compute deltas unless the environment, durability, cold/warm condition, workload and its hash, model settings, account and team hashes, viewport, instrumentation, history, and capture mode are all known and identical. The same source hash on both sides is labelled an A/A noise control. Fewer than five valid pairs are labelled descriptive. Improvement is the paired median of candidate minus baseline. Every live sample sends a real prompt and can incur charges, so `ab` prints the total before it starts.

## Run a reproducible CPU baseline

Run the browser benchmark without starting Next.js or configuring services:

```sh
node --run test:perf
```

This requires local Chrome. Set `CHROME_PATH` if it is installed outside the default macOS path. The test serves the current source modules on a loopback address and replays synthetic events through the production delivery queue, checkpoint and visible-entry reducers, thread grouping, and draft sanitizer/patcher. It does not load `.env.local`, contact services, or call a model.

The workload matrix uses initial HTML sizes of 32, 128, and 384 KiB, each with 10 and 200 completed turns. Every case runs with tracing on and off, with alternating order, 5 warmup updates, and 30 measured updates. Each update appends HTML to the draft and text to the active response. The test verifies the final DOM, draft offsets, event cursor, and agreement between the checkpoint and visible entries before reporting timings.

The console shows p50/p95 synchronous update durations and a phase breakdown in milliseconds. Updates over 16.7 ms are counted as a diagnostic reference for a 60 Hz frame, not as a measurement of dropped frames or a pass/fail threshold. Small phase durations can fall below the browser clock's resolution. Do not infer zero cost from a rounded value or treat one on/off pair as a precise tracing-overhead estimate.

Each run writes a new directory under `.next/fx0-perf/` containing:

- `summary.json`: workload sizes, sample counts, browser and Node versions, and phase statistics.
- `trace.json`: measured tracing-on spans in Chrome Trace Event format, excluding warmups. Open it in Perfetto or pass its exact path to `node scripts/trace-report.mjs`.

This first baseline measures synchronous CPU work on detached documents. It excludes React commits, Markdown rendering, layout, paint, scheduling gaps, Next.js routes, model time, and database/network latency. It helps prioritize browser work; use the request traces above to investigate server and service delays. Repeat runs under comparable machine load before claiming a regression or improvement.

## Inspect durations

Pass a server trace file, the server trace directory, and optionally a downloaded browser file:

```sh
node scripts/trace-report.mjs .next/fx0-traces
node scripts/trace-report.mjs .next/fx0-traces /path/to/fx0-browser-trace.json
```

The report groups complete spans by name and prints count, p50, p95, and maximum duration in milliseconds. Instant events, including the first observed provider chunk and preview presentation signal, are listed separately. With few samples, percentiles are descriptive rather than a performance guarantee.

Export a combined Chrome Trace Event file for Perfetto:

```sh
node scripts/trace-report.mjs --json .next/fx0-traces /path/to/fx0-browser-trace.json > /tmp/fx0-trace.json
```

Open that file in a local trace viewer. Browser and server events have separate process lanes. Durations use each process's monotonic clock; exported timestamps use its time origin. Cross-process alignment is approximate, so do not treat clock skew as network latency or add overlapping spans together.

## Interpret the stages

| Events | What they measure |
| --- | --- |
| `request.auth`, `request.handle` | Cookie/session handling and the request through response headers, not the lifetime of its SSE body |
| `prompt.send`, `prompt.headers` | Browser fetch through response headers and the headers milestone; thumbnail preparation happens before the fetch span |
| `prompt.journal`, `prompt.credential`, `prompt.hydrate`, `prompt.bind`, `prompt.accepted`, `prompt.assets` | Admission stages on the server |
| `model.prepare`, `model.headers` | Funding/reservation preparation and the transport call until it returns a response |
| `model.first_chunk`, `model.stream` | First bytes observed by the existing draft reader and its streaming lifetime; the first chunk is not necessarily a text token |
| `tool.execute` | Host preparation, execution, and cleanup, without tool names or arguments |
| `projector.history`, `projector.batch`, `journal.commit` | History work, a projection batch, and its journal commit |
| `draft.write`, `sse.poll`, `sse.deliver`, `sse.receive`, `event.apply` | Draft persistence, server reads/delivery, browser reception, and synchronous state-update scheduling |
| `draft.sanitize`, `draft.patch` | Draft cleaning and DOM parsing/patching; these do not measure layout or paint |
| `artifact.prepare`, `preview.presented` | Published wrapper preparation and the browser's accepted paint signal; image loading is not separately timed |
| `browser.longtask` | Counts of observed long tasks, not their durations |

The model stream events are emitted where the existing draft observer reads the response; responses without that observer have no stream span. The preview signal does not measure React commit time. Use Chrome Performance and React Profiler for layout, paint, and commit analysis.

Browser prompts carry a validated random trace ID to the server. Session and turn IDs join later operations. The mapping of trace IDs to turns is bounded and process-local: after recovery in another process, correlate by session and turn rather than expecting the original trace ID everywhere. A stream or projection batch can cover several turns and is correlated at session level.

## Privacy and tests

The recorder accepts fixed event names, bounded identifiers, and an allowlist of finite numeric or boolean measurements. It does not record prompts, generated HTML, image data, URLs, tool arguments, error messages, cookies, or credentials. No trace API route is exposed. Existing application logs are separate from these performance traces and retain their existing behavior.

Run the deterministic tracing tests without services or a model:

```sh
npm run test:trace
```

To exercise the recorder and draft patcher in local Chrome, run `npm run test:trace:browser`. Set `CHROME_PATH` if Chrome is installed outside its default macOS path. This test uses a loopback server and synthetic HTML, with no model or database calls.

## Establish a real baseline before optimizing

First capture one successful real prompt and verify its browser milestones against the matching server spans. A transport fixture or an authentication failure is not that baseline. Distinguish acceptance, first raw provider bytes, first text received, first HTML received, final journal completion, and preview presentation; none is interchangeable with another.

For each real run, record the code revision, model/settings, anonymous workload label, new-versus-existing chat, cold/warm evidence, trace ID, and missing spans. Preserve failures and timeouts instead of silently retrying or discarding them. Do not calculate network latency by subtracting timestamps from different process clocks, and do not add nested spans into a fictional total.

Only then propose a change to a measured bottleneck. Compare baseline and candidate with the same instrumentation, account/team, model settings, workload, history, browser, viewport, and cache policy. Balance A/B and B/A order across repeated comparable pairs, keep initial/cold requests separate, and report sample counts and failures alongside paired deltas. Real submissions can consume credits; agree on the workload and number of requests before running a campaign.

The live driver currently executes one prompt, not an automated multi-deployment A/B campaign. Compare a small tracing-on/off control before drawing conclusions about instrumentation overhead; retain the same tracing configuration for both optimization variants.
