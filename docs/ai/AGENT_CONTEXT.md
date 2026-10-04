# Parser Agent Context

status: canonical-agent-context
audience: AI agents
scope: official DEMO QA only
source_of_truth_order:
  1. captured request/response evidence
  2. provider runtime state
  3. stable provider adapter behavior
  4. UI control discovery
  5. heuristics
  6. visual/coordinate fallback

## Core objective

Discover and traverse provider game behavior without requiring prior semantic knowledge of each button.

The parser MUST prefer:
control/action -> request delta -> response -> runtime state -> next available actions

The parser MUST NOT require:
button label -> guessed semantic -> hardcoded game behavior

Unknown actions are valid evidence.

## Non-negotiable invariants

1. A purchase is NEVER assumed terminal.
2. After every action, observe before acting again.
3. If protocol/runtime continues automatically, wait.
4. If the system becomes quiet and awaits input, enumerate current controls/actions.
5. Branch every distinct internal selection in an isolated replay path.
6. Re-open a clean DEMO session for independent sibling branches.
7. Deduplicate only by a stable state fingerprint, never by button text alone.
8. Preserve raw request and response evidence even when operation classification is unknown.
9. Provider-specific transport parsing is separate from provider-specific UI/runtime control discovery.
10. Never infer purchase count from labels when request evidence provides an exact selector.
11. Treat transient fields used as replay prerequisites as state (examples: BGaming state_lock, Pragmatic bgid/ind state, provider round IDs).
12. UI names such as Continue, FreeSpinsContinueButton, StartSpin_Button, etc. are hints only.
13. "spin" continuation must be identified by exact provider event/control identity or request evidence, not substring matching.
14. Canvas fallback must use trusted Playwright input where browser/game code rejects synthetic isTrusted=false events.
15. CI access failure is not equivalent to protocol failure.

## Current provider coverage

| provider | runtime/control adapter | protocol mapping | evidence quality |
| --- | --- | --- | --- |
| Pragmatic Play | specific, mature | advanced | HAR + runtime + live DEMO |
| 3Oaks | specific, mature | partial/advanced | runtime + live DEMO |
| BGaming | generic-canvas operational; provider-specific protocol pending | advanced from HAR | 9 HAR samples + live DEMO |
| Belatra | provider-specific runtime adapter; CI blocked by Cloudflare | advanced sampled runtime/protocol mapping | 8+ local HAR samples + bundle evidence |

## Current implementation components

- src/tree-crawler.js: provider-agnostic replay/state tree
- src/providers/pragmatic.js: Pragmatic runtime/control adapter
- src/providers/threeoaks.js: 3Oaks runtime/control adapter
- src/providers/belatra.js: Belatra runtime/configuration adapter + plaintext protocol hook
- src/providers/generic-canvas.js: fallback DOM/canvas adapter
- src/providers/index.js: provider detection

Target architecture:
- src/providers/: controls/runtime/state extraction
- src/protocols/: request/response parsing and normalized protocol state
- tree-crawler: provider-agnostic orchestration only

## Normalized state concept

A provider analyzer SHOULD emit:

```json
{
  "provider": "provider-id",
  "phase": "base|purchase|selection|feature|terminal|unknown",
  "terminal": false,
  "automaticActivity": false,
  "selectionRequired": null,
  "availableActions": [],
  "stateToken": null,
  "roundId": null,
  "raw": {}
}
```

Fields MAY be unknown. Unknown is preferable to guessed.

## Generic execution algorithm

```text
OPEN clean official DEMO
BOOTSTRAP provider runtime
OBSERVE state/control inventory

for each branch:
  REPLAY exact path from root
  EXECUTE one action
  CAPTURE request/response delta
  WAIT until protocol/runtime quiet
  NORMALIZE provider state

  if automatic activity continues:
      WAIT and observe again

  if protocol exposes explicit next action(s):
      branch/repeat according to provider contract

  else if runtime exposes new controls:
      branch each distinct control

  else:
      use fallback input sequence:
        canvas_center
        Enter / Space
        canvas 3x3 grid
      each fallback in isolated replay branch

  DEDUPE equivalent child states
  QUEUE unseen states
```

## Interaction fallback priority

1. provider runtime controls
2. provider protocol available_actions / explicit server state
3. DOM controls
4. trusted canvas center tap
5. trusted keyboard Enter / Space / Escape
6. trusted 3x3 canvas grid
7. broader adaptive canvas exploration only when needed

Every fallback action MUST be correlated to network/state evidence.

## Feature continuation rules

Purchase/feature branches can require any mixture of:
- automatic server progression
- repeated spin
- repeated respin
- repeated freespin
- confirmation
- internal option selection
- picker choice
- click/tap to continue
- collect
- terminal response

Do not encode "buy -> done".

## Branch identity

A replay path is an ordered list of action descriptors.

Example:
```json
[
  {"kind":"runtime","name":"buy_feature"},
  {"kind":"purchase-option","selector":{"index":1}},
  {"kind":"confirm"},
  {"kind":"canvas-tap","nx":0.5,"ny":0.5},
  {"kind":"protocol-action","name":"respin"}
]
```

The path is not semantic truth. It is a reproducible interaction trace.

## State fingerprint

Include whenever available:
- provider
- frame/runtime identity
- provider state snapshot
- active/visible controls
- purchase selector state
- feature/bonus state
- round/state token
- canvas/state sample if no runtime objects exist

Exclude:
- volatile timestamps
- request IDs that do not alter behavior
- analytics/telemetry
- ephemeral asset URLs

## Traffic policy

Keep raw network evidence.

Classification must operate on gameplay protocol requests, not:
- static assets
- telemetry
- generic saveSettings unless provider semantics require it
- unrelated POSTs

The fact that a control causes network traffic is evidence.
It is NOT automatically evidence of spin/purchase/bonus.

## Evidence labels

OBSERVED:
directly present in HAR, response, runtime, or reproducible DEMO result.

IMPLEMENTED:
behavior exists in repository code.

INFERRED:
strong interpretation derived from multiple observations but not directly encoded.

UNKNOWN:
not supported by current evidence.

Agents must preserve these distinctions.

## Structural configuration rule

Provider-specific finite settings that change purchase/feature semantics are part of the state tree.

Canonical example: Belatra Legacy of Doom `nlines`.

The crawler/provider adapter must:
- expose exact configuration actions;
- include configuration in state snapshot;
- branch each supported structural value;
- traverse purchase/features from each configuration state.

Purchase selection and purchase confirmation are separate transitions when the provider runtime exposes both.

## Provider files

- docs/ai/providers/PRAGMATIC.md
- docs/ai/providers/THREEOAKS.md
- docs/ai/providers/BGAMING.md
- docs/ai/providers/BELATRA.md
- docs/ai/STATE_MACHINE_SPEC.md
- docs/ai/EVIDENCE_MANIFEST.json

## Skill

Use:
skills/game-protocol-mapper/SKILL.md
