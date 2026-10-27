> Nota per Live 3.0: il modulo è ora autonomo. Le istruzioni correnti sono [AVVIO_LIVE_3.0.md](AVVIO_LIVE_3.0.md) e [LIVE_API_3.0.md](LIVE_API_3.0.md). Il testo sottostante documenta l’integrazione e le versioni precedenti.

# #AIR3 Studio integration contract

This contract describes the shipped gateway, player and broadcaster. The gateway
is separate from the dApp trading backend. Its default URL is
`http://127.0.0.1:5890`; the studio entry point is `/studio`.

The frontend is compiled from `studio-broadcast/public/` into `public/build/` by
`npm run build`. Three.js 0.186.1 and its addons are served locally under
`/vendor/three/`; runtime assets do not require an external CDN. Rebuild after
changing browser modules. `public/build/manifest.json` records source and
output hashes for that build.

## Authentication and browser ownership

Narration and player APIs require `Authorization: Bearer <token>`. Producer and
player tokens are separate. Tokens must not appear in query strings or
diagnostics. `/api/health`, `/api/public-config`, `/api/emotions`,
`/api/expressions` and static assets are public.

A manually opened studio is a muted observer. The broadcaster owns the player
credentials and calls `window.air3Studio.connectPlayer({token, playerId})`.
Opening multiple preview tabs does not create multiple audio consumers.

## Producer API

`POST /api/narrations` accepts:

```json
{
  "id": "air3-comment-001",
  "text": "The market update to read aloud.",
  "language": "en",
  "priority": 0,
  "emotion": { "name": "focused", "intensity": 0.35 },
  "presentation": { "action": "monitor", "monitor": "center" }
}
```

| Field | Contract |
| --- | --- |
| `id` | Optional idempotency key. Safe bounded identifier, 1–128 characters; generated when omitted. |
| `text` | Required non-empty string, bounded by configured `maxTextChars`. |
| `language` | `en` or `it`; defaults to `en`. |
| `priority` | Integer from −100 to 100; defaults to 0. Higher priorities are claimed first, then insertion order. |
| `expiresAt` | Optional absolute Unix timestamp in milliseconds, constrained by queue policy. |
| `emotion` | Optional supported name or `{name,intensity}`. Names: `neutral`, `warm`, `happy`, `sad`, `focused`, `concerned`, `surprised`; supported Italian aliases are discoverable through `/api/emotions`. Intensity is a finite number from 0 to 1; default 0.35. |
| `presentation` | Optional `{action:"monitor",monitor:"left"\|"center"\|"right"}` or `{action:"home"}`. The nested object rejects unknown keys, actions and monitor names. Omit this field when no stage cue is wanted; explicit `null` is invalid input. |

The response is HTTP 202 with the job ID, status and `duplicate` flag. Reusing
an ID with changed text, language, priority, explicit expiry, emotion or presentation returns
a conflict. The same text under a new ID is a new job. Missing emotion is
delivered as `{name:"neutral",intensity:0.35}`. Emotion affects avatar
presentation only; it is not forwarded as a provider TTS style control.

The optional `presentation` cue travels with the existing narration lease. The
browser applies it once when that job begins playing, calling the corresponding
studio gesture/home command. It does not schedule exact word-level gestures or
delay audio until a walk is complete. It does not introduce another queue,
player or control connection. Existing producers that omit the field keep their
original content hash and behavior; old SQLite rows migrate to a nullable
`presentation_json` column. See [PRESENTATION_API.md](PRESENTATION_API.md).

`GET /api/narrations/:id` returns status, timestamps and an optional sanitized
error. States are `queued`, `generating`, `ready`, `leased`, `playing`,
`finished`, `failed`, `cancelled`, `expired`.

`DELETE /api/narrations/:id` cancels the job and is idempotent for terminal
states. A player already speaking observes cancellation through lease checks;
sound does not necessarily stop at the instant the DELETE completes.

## Voice generation and lip-sync

The external TTS provider accepts an OpenAI-style `/v1/audio/speech` request.
The example uses Kokoro, English voice `af_jessica` and Italian voice `if_sara`.
A replacement must return the WAV PCM16 format accepted by `src/speech.mjs`.
The provider service itself is deployed independently.

Text is segmented, synthesized sequentially, validated and assembled into a
complete WAV. The job remains `generating` during synthesis and alignment.
Playback is fully buffered, not progressive TTS streaming.

Rhubarb 1.14.0 runs on the final WAV. Bundled executables target Linux x64 and
Windows x64; `AIR3_RHUBARB_PATH` can override the binary. English selects
`pocketSphinx`; Italian selects `phonetic`.

| Mode | Result when alignment fails or times out |
| --- | --- |
| `auto` | Ready audio with `{kind:"amplitude",reason:"alignment-unavailable"}` or `"alignment-timeout"`. |
| `required` | Failed job with `TTS_LIPSYNC_UNAVAILABLE` or `TTS_LIPSYNC_TIMEOUT`. |
| `off` | Ready audio with `{kind:"amplitude",reason:"disabled"}`. |

The successful timeline format is:

```json
{
  "kind": "rhubarb",
  "version": "1.14.0",
  "recognizer": "phonetic",
  "clock": "audio",
  "duration": 2.4,
  "processingMs": 123,
  "mouthCues": [
    { "start": 0.0, "end": 0.2, "value": "X" },
    { "start": 0.2, "end": 0.4, "value": "B" }
  ]
}
```

These values illustrate the schema, not a measured job. Times are seconds
relative to the final audio. Valid shapes are `A B C D E F G H X`. Timelines
are bounded, ordered and duration-validated; silence and gaps resolve to `X`.
They are not word timestamps, fifteen fully solved visemes or a RigLogic solve.

The player samples cues using `AudioContext.currentTime - playbackStart`.
Measured amplitude modulates facial movement; it does not invent phonemes when
the timeline is missing. The UI and diagnostics report `rhubarb:<recognizer>`
or `amplitude` for the active job.

## Player API and lease lifecycle

`POST /api/player/claim` accepts `{playerId:string}` and returns `{job:null}` or:

```json
{
  "job": {
    "id": "air3-comment-001",
    "text": "The market update to read aloud.",
    "audioPath": "/api/audio/air3-comment-001",
    "durationMs": 2400,
    "leaseToken": "opaque-lease-token",
    "lipSync": { "kind": "amplitude", "reason": "disabled" },
    "emotion": { "name": "focused", "intensity": 0.35 },
    "presentation": { "action": "monitor", "monitor": "center" }
  },
  "leaseMs": 15000
}
```

`presentation` is `null` when omitted by the producer, including jobs migrated
from earlier packages. `lipSync` may instead contain the Rhubarb timeline above. Only one global lease
can be active. Another player's active lease yields no job. Work that cannot
finish before expiry, including the start margin, is not claimed.

`POST /api/player/:id/events` accepts `{playerId,leaseToken,event,error?}`, where
`event` is `started`, `heartbeat`, `finished` or `failed`. Every event validates
ownership. Heartbeats extend the lease but never the original job expiry.
Download and decode happen before `started` and remain protected by heartbeat
and local watchdog.

`GET /api/audio/:id` requires player authorization and returns WAV bytes with
`Cache-Control: no-store`. Audio is addressed through a job ID; arbitrary
filesystem paths or remote audio URLs are not accepted.

Lease failure, expiry or cancellation stops local playback. Gateway restart
expires leased/playing jobs instead of replaying possibly spoken words. Valid
queued/ready jobs may resume. This is not a platform-wide exactly-once delivery
guarantee. On completion or interruption the player returns to idle and clears
the active cue, presentation metadata and emotional state.

## Browser API and readiness

`window.air3Studio` exposes:

| Member | Purpose |
| --- | --- |
| `ready` | Promise fulfilled only after the scene and configured avatar have produced a rendered frame. |
| `armAudio()` | Prepare the Web Audio graph and silent source before tab capture. |
| `connectPlayer({token,playerId})` | Start authorized claims using the existing audio graph. |
| `disconnectPlayer()` | Stop the player and release its local playback resources. |
| `setCamera(mode,immediate=false)` | Select `auto`, `wide`, `presenter` or `screens`; immediate changes permit repeatable inspection. |
| `captureFrame()` | Return a pure WebGL PNG data URL using the current pose, without advancing animation time. |
| `diagnostics()` | Report frame count, frame timestamp, renderer, quality, avatar, audio, active job and data state. Never return tokens. |

The GLB loads first, web materials are applied and the avatar rig is created.
A failed configured avatar rejects startup. A calibration mannequin is allowed
only when no avatar URL is configured; it is not a silent replacement for a
broken asset. Disposal or context loss during initialization rejects pending
readiness. First-avatar-frame waiting is bounded at 30 seconds on hardware or
45 seconds in the software profile.

After startup, renderer diagnostics expose context loss and stalled frames for
the broadcaster watchdog. Context restoration rebuilds the studio environment.
Resources and animation loops are released on page close. The `ready` promise
is the startup gate; diagnostics are telemetry, not a substitute for awaiting it.

The included rig preserves source geometry and skinning, corrects animation
translations and uses 35 facial bone controls plus 29 selected source
correctives. Nine mouth shapes, procedural blink/gaze and bounded emotional
poses are supported. Full MetaHuman RigLogic, cloth simulation and complete
Unreal facial parity are not implemented.

## Public configuration and health

`GET /api/emotions` and its alias `GET /api/expressions` return the same public
catalog: `{emotions:[...canonicalNames],aliases:{...italianToCanonical}}`. Both
are read-only and disclose no narration, token or queue contents. They are
available in the gateway as well as the standalone preview.

`GET /api/public-config` returns:

```json
{
  "project": "air3",
  "dappBaseUrl": null,
  "avatarUrl": "/assets/air3/models/AIR3-runtime.glb",
  "defaultTimeframe": "1h",
  "renderQuality": "high",
  "width": 1920,
  "height": 1080,
  "fps": 30
}
```

These are configuration values, not benchmark guarantees. Avatar paths must
refer to a permitted local asset. A remote authenticated asset URL is not
accepted. `renderQuality` supports `auto`, `high`, `balanced`, `software`.
An explicit URL `quality` overrides configuration; `auto` selects based on the
renderer. The shipped environment example explicitly chooses `high`.

`GET /api/health` includes speech capabilities
`{mode:"fully-buffered",lipSync:"auto"|"required"|"off",clock:"audio"}`.
This is configuration telemetry, not a successful per-job alignment or proof
of TTS connectivity. UI health polling is separate from lease heartbeats and
permits only one request in flight.

## Gateway module contract

`src/gateway.mjs` exports async `createGateway(config)` returning
`{server,close}`. The caller listens on `config.host` and `config.port`.

| Configuration | Fields |
| --- | --- |
| Service | `host`, `port`, `dataDir`, `publicDir`, `nodeModulesDir` |
| Authorization | `producerToken`, `playerToken` |
| Presentation | `dappBaseUrl`, `avatarUrl`, `renderQuality`, `width`, `height`, `fps` |
| `tts` | `baseUrl`, `apiKey`, `model`, `voiceEn`, `voiceIt`, `speed`, `timeoutMs`, `maxChunkChars` |
| `lipSync` | `mode`, `binary`, `timeoutMs`, `threads` |
| `queue` | `maxPending`, `maxTextChars`, `maxAgeMs`, `leaseMs`, `retentionMs` |

The gateway owns the durable queue, single synthesis worker, WAV assembly,
alignment, authorization, static assets, cancellation, expiry and cleanup.
Tests may inject `config.fetchImpl` and `config.now`. Shutdown aborts active
generation/alignment and closes the queue. Credentials must not enter logs.

## Market-data boundary and broadcaster

The studio reads public dApp APIs without wallet providers or order endpoints.
AIRTrack and auto-trading are separate feeds. The public `/ws` channel receives
updates only; no application messages are sent on it. Display age measures
receipt time and does not bypass upstream candle caching. Legacy GET handlers
may have their own internal cache/database effects.

Chromium headless and `puppeteer-stream` capture the same tab's video and audio.
FFmpeg controls final H.264/AAC encoding, resolution, rate and keyframe interval.
Default output is a local file. RTMP/RTSP require destination configuration;
RTSP mode publishes to an existing server. Hardware WebGL and encoder
availability are checked separately. Intermediate WebM requires re-encoding;
no zero-copy or measured production frame-rate claim is made here.

Validation is indexed in [VALIDAZIONE.md](VALIDAZIONE.md). Imported logs,
implementation checks and final compiled checks have separate provenance;
an older GPU result does not certify the new runtime.

## Espressione di base della regia nella 2.3

La risposta di claim aggiunge `emotionExplicit`, ricavato dalla presenza di `emotion_json`. Il payload `emotion` preesistente rimane invariato per compatibilità; nessun nuovo campo è richiesto al producer. Il player dello Studio propaga il flag: con `false` il renderer usa l’espressione corrente della regia, anche mentre legge testo senza indicazioni emotive. Con `true` applica l’emozione esplicita del producer durante il parlato. Un claim precedente senza flag mantiene il comportamento precedente. Alla fine o dopo una cancellazione torna la scelta della regia. Il default della release è `happy`, intensità `1`. Questa modifica non altera schema SQLite, idempotenza, audio o percorso del bridge Eliza.
