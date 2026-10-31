# Presentation and Stage Directing APIs

Producers and autonomous agents (such as ElizaOS or AIRdApp bots) can direct the presenter to present studio monitors or return home via optional payload fields in the speech narration endpoint.

## Example Request

Send an authenticated request to `POST /api/live/narrations`:

```json
{
  "id": "commentary-monitor-001",
  "language": "en",
  "text": "Let us examine the latest liquidation sweep on the center monitor.",
  "emotion": { "name": "focused", "intensity": 0.4 },
  "presentation": { "action": "monitor", "monitor": "center" }
}
```

### Supported Values

| Intent | `presentation` Payload |
|---|---|
| Present Left Monitor | `{"action":"monitor","monitor":"left"}` |
| Present Center Monitor | `{"action":"monitor","monitor":"center"}` |
| Present Right Monitor | `{"action":"monitor","monitor":"right"}` |
| Return Home to Desk | `{"action":"home"}` |
| No Movement Command | Omit the `presentation` field |

Malformed values or unrecognized monitor names return HTTP 400 `INVALID_PRESENTATION`. Payloads are strictly validated and cannot contain arbitrary URLs or executable scripts.

## Execution Model

The gateway stores directing commands alongside narration records. When the internal broadcast player claims the audio lease, the frontend dispatches the stage motion action in parallel with speech audio playback. Movement does not block audio streaming or introduce artificial speech pauses.

## Idempotency and Storage

Directing parameters participate in cryptographic idempotency hashing. Submitting the same narration ID with conflicting presentation instructions returns HTTP 409 `IDEMPOTENCY_CONFLICT`.

## Emotion Catalog

`GET /api/emotions` and `GET /api/expressions` are public endpoints returning canonical emotion names: `neutral`, `happy`, `sad`, `surprised`, `warm`, `focused`, `concerned`, alongside supported aliases.
