# Belatra

status: provider-map
confidence: medium
sources:
- uploaded HAR: belatragames.com_Archive [26-10-03 20-34-36].har
- local official DEMO session
- CI bootstrap diagnostics

## Captured game [OBSERVED]

Page:
Belatra Stars Blast

Gameplay host:
demo.bltrm.com

## Transport [OBSERVED]

Primary gameplay endpoint:
POST /game

Observed request body:
```text
d=<opaque/encrypted-or-encoded-payload>&sid=<session>
```

Observed response:
JSON/object containing an opaque d payload.

A single endpoint multiplexes multiple game actions.

Therefore endpoint path alone cannot classify:
- spin
- purchase
- bonus
- picker
- continue
- collect

## Bootstrap evidence [OBSERVED]

Provider/game resources expose common runtime/core bundles.

Additional bootstrap request observed:
user data/game list retrieval including GAMELIST semantics.

## Critical analysis implication

The useful semantic action likely exists client-side before d is serialized/encrypted.

Preferred Belatra strategy:
1. identify function that constructs plaintext action/state
2. instrument/hook immediately before d encoding
3. record normalized plaintext + opaque network pair
4. correlate with runtime control
5. keep /game request/response as transport evidence

Do not prioritize cryptanalysis when a pre-serialization runtime hook is available.

## CI behavior [OBSERVED]

GitHub Actions can discover the direct official demo URL:
demo.bltrm.com/belatra/demo?...

But the CI runner receives Cloudflare security verification / Turnstile before game runtime.

Classification:
CI_ACCESS_BLOCK

This is not evidence that Belatra runtime/protocol parsing fails locally.

Do not attempt to bypass provider anti-bot/security verification.

## State model

Current transport alone is insufficient to determine generic terminal/continuation semantics.

Normalized analyzer may emit:
```json
{
  "provider": "belatra",
  "phase": "unknown",
  "terminal": null,
  "availableActions": [],
  "opaqueTransport": true,
  "sessionPresent": true,
  "raw": {}
}
```

until runtime plaintext instrumentation is available.

## Next implementation target

Provider-specific runtime/protocol adapter should discover:
- action object before d serialization
- spin action
- purchase/feature action
- bonus continuation
- selection/pick indices
- terminal/round-state field
- client sequence/counter if required

## Unknowns

- d encoding/encryption algorithm
- universal plaintext schema
- generic terminal field
- generic action names across Belatra families

Keep all /game deltas and runtime snapshots.
