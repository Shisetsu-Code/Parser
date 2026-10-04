---
name: game-protocol-mapper
description: Analyze official DEMO game runtimes and HAR/network evidence, separate provider-specific control/runtime logic from protocol parsing, infer replayable state machines, and update Parser without hardcoding individual games.
---

# Game Protocol Mapper

Use this skill when extending Parser to a new provider, analyzing HAR files, diagnosing a game that does not traverse correctly, or converting generic-canvas evidence into a provider-specific adapter/analyzer.

Scope: official DEMO QA/testing only.

## Load context first

Read:
1. docs/ai/AGENT_CONTEXT.md
2. docs/ai/STATE_MACHINE_SPEC.md
3. docs/ai/providers/<PROVIDER>.md when provider is known
4. docs/ai/EVIDENCE_MANIFEST.json

Do not rely on previous conversation memory when repository evidence exists.

## Required reasoning discipline

Every claim must be tagged mentally as:
- OBSERVED
- IMPLEMENTED
- INFERRED
- UNKNOWN

Never convert INFERRED into IMPLEMENTED without code/evidence.
Never convert UNKNOWN into a hardcoded rule.

## Provider separation

Maintain two conceptual layers.

Provider runtime/control layer:
- detect runtime
- enumerate controls
- press controls
- read local runtime state
- bootstrap official DEMO

Provider protocol layer:
- select gameplay requests
- parse request
- parse response
- normalize phase/state
- expose explicit next actions
- expose terminal condition
- preserve state tokens

Tree crawler must remain provider-neutral.

## HAR workflow

For each HAR:

1. identify official game/provider/title
2. inventory POST/WS gameplay transports
3. discard telemetry/static assets
4. group requests by endpoint/schema
5. parse request bodies
6. parse response bodies
7. locate changing round/state tokens
8. locate purchase selectors
9. locate continuation markers
10. locate terminal markers
11. compare multiple games before declaring provider-wide semantics

Output:
- protocol family
- request schema
- response schema
- purchase selector schema
- continuation rule
- terminal rule
- replay prerequisites
- unknowns

## Purchase handling

Do not model purchase as one scalar unless evidence proves it.

Preserve complete selector object.

Examples already observed:
- Pragmatic: purchase may lead to internal doBonus selection
- BGaming: feature_id
- BGaming: purchased_feature_level
- BGaming: isSuperBonus
- BGaming: distinct purchased_feature values

Represent:
```json
{
  "baseName": "...",
  "selector": {},
  "raw": {}
}
```

## Post-action algorithm

After every interaction:

```text
CAPTURE before index
PRESS action
WAIT minimum action delay
PARSE gameplay delta
READ runtime/protocol state
SETTLE until gameplay traffic + state are quiet

if automatic progression:
  WAIT

if explicit provider next action:
  execute/branch that action

else if new runtime controls:
  branch controls

else:
  generic trusted input fallback
```

Never send a second pick while previous result is pending.

## Internal selections

If an action reveals multiple selections:
- isolate siblings
- replay parent path from clean session
- select exactly one branch
- wait
- parse child state
- queue unseen child

Do not test multiple sibling selections in one mutated feature session.

## Continue/click-anywhere handling

When state is nonterminal but no semantic control exists:
1. wait
2. rescan runtime/DOM
3. trusted canvas center
4. Enter
5. Space
6. 3x3 trusted canvas grid

Do not use synthetic DOM events for Canvas/WebGL if trusted Playwright input is possible.

## Repeated feature actions

Repeat spin/respin/freespin only when supported by:
- protocol available_actions
- explicit provider runtime state
- exact stable control + gameplay effect

Never infer repeated spin from substring text.

## Provider-specific key rules

### Pragmatic
Parse doInit/doSpin/doBonus.
Preserve pur/bgid/ind/end and response state.
Purchase may reveal an internal picker.
Wait for bonus response before next pick.

### 3Oaks
Use GR.UI.view plus internal Flow/buyFeature state.
Control inventory alone may miss popup state.

### BGaming
Detect protocol family:
- command endpoint
- JSON-RPC /api

command:
use flow.available_actions.

JSON-RPC:
use final and state_lock.
Always update state_lock.
Preserve full purchase selector.

### Belatra
POST /game multiplexes opaque d.
Prefer hooking plaintext before serialization.
CI Cloudflare challenge is CI_ACCESS_BLOCK, not protocol failure.

## Code update policy

Prefer:
- new provider analyzer
- normalized state parser
- generic reusable control strategy

Avoid:
- game-name if/else
- fixed coordinates for one title
- fixed purchase counts
- hardcoded session/token values
- interpreting analytics traffic as gameplay

## Verification

For a new mapping:
- run syntax check
- run one known representative game
- run at least one unseen game
- verify replayFailures
- verify request/response correlation
- verify sibling branch isolation
- verify terminal/continuation behavior

If provider DEMO is inaccessible in CI:
- diagnose and label CI_ACCESS_BLOCK
- do not bypass anti-bot
- use local HAR/runtime evidence

## Update documentation

After new evidence:
- update provider doc
- update EVIDENCE_MANIFEST.json
- update unknowns
- record whether rule is sample-specific or provider-wide

See references/normalized-contract.md.
