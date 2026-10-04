# Provider-Neutral State Machine Specification

status: canonical
audience: AI agents

## Purpose

Define the behavior required to traverse provider games whose feature flow is not known in advance.

## State categories

BASE:
normal playable state.

CONFIGURATION:
pre-action state whose mutable settings alter purchase/feature semantics or branch topology. Examples: active lines, feature mode, volatility/ante mode when provider evidence marks it structural.

PURCHASE_MENU:
one action exposed multiple feature purchase candidates.

CONFIRMATION:
a selected action requires a second explicit confirmation.

SELECTION:
feature is active but requires an internal choice/pick.

FEATURE_ACTIVE:
server/runtime indicates an unfinished feature.

AUTO_PROGRESS:
runtime/server is changing without user input.

WAITING_INPUT:
no automatic change; at least one action is required.

TERMINAL_FEATURE:
feature ended and normal/base action is available again.

UNKNOWN:
insufficient evidence.

## Configuration dimensions

Configuration MUST be part of state identity when provider evidence shows it affects:
- available purchase options;
- purchase price formula beyond trivial display formatting;
- feature selector payload;
- payout/feature logic;
- subsequent state topology.

For a finite structural dimension:
- enumerate each supported value;
- create one replayable configuration control per value;
- queue each resulting state before purchase traversal;
- never dedupe states across different structural values.

Example observed in Belatra Legacy of Doom:
```text
nlines in 1..10
configuration(nlines)
  -> purchase
  -> feature
```

Store dependent values such as betPerLine and betPerGame in the snapshot.

Do not automatically cross-product every monetary denomination. Promote a bet dimension to structural only when evidence shows more than scalar money scaling or when it changes available actions/options/state topology.

## Selection versus submission

A choice and its submit/confirm action are separate transitions when the runtime exposes both.

Required model:
```text
PURCHASE_MENU
  -> SELECT(option)
  -> CONFIRMATION
  -> SUBMIT/START/BUY
  -> FEATURE_ACTIVE
```

Do not treat SELECT as purchase completion.

## Transition contract

After every action A:

1. record network index N0
2. execute A
3. wait minimum action delay
4. read runtime/provider snapshot S1
5. parse request/response delta D=N[N0:]
6. capture provider plaintext/runtime protocol events when available
7. enter settle loop

Settle loop ends only when:
- no gameplay protocol request appears for quiet window AND
- no provider plaintext protocol event appears for quiet window AND
- normalized state fingerprint is stable for quiet window

Static resources and telemetry do not reset quiet window.

## Automatic progression

If state or protocol continues changing without input:
- do not press controls
- keep recording
- update state token/round token
- exit only after quiet window

## Required-input progression

When quiet:
- prefer explicit provider actions
- else provider runtime controls
- else DOM controls
- else generic trusted input fallbacks

## Repetition

Repeated spin/play/respin/freespin is valid only if:
- provider protocol exposes it; OR
- exact runtime control remains available AND prior action produced gameplay evidence; OR
- provider-specific analyzer marks it as required

Do not repeat because a label contains "spin".

Stop repetition when:
- terminal=true
- available action changes
- exact control disappears
- no gameplay request/state change
- repeat limit reached

## Selection trees

When action reveals K choices:
- create K sibling branches
- each sibling starts from a fresh DEMO session
- replay the parent path
- make exactly one new selection
- observe child state
- never consume all siblings in one mutable feature session

## Generic continuation

Fallback sequence for unidentified interstitial:
1. wait
2. rescan
3. exact runtime/DOM continuation controls
4. trusted canvas center
5. Enter
6. Space
7. 3x3 canvas grid

Every fallback is a branch.
Equivalent states are deduplicated.

## Terminal detection

Provider-specific analyzers override generic heuristics.

Examples:
- BGaming command family: available_actions returns to spin with state closed/ready
- BGaming JSON-RPC: result.final=true
- Pragmatic: bonus/game state indicates end; doBonus/doSpin response semantics
- 3Oaks: Flow/model returns base/idle state
- Belatra: plaintext ajaxQueue actions + runtime state; universal terminal rule remains partially unknown

## Normalized edge record

```json
{
  "from": "state-id",
  "action": {},
  "press": {"ok": true},
  "network": [],
  "protocol": [
    {"provider":"belatra","payload":{"q":"savePlayerChoice","name":"Bonus2","att":0,"info":3}}
  ],
  "automatic": {
    "waitedMs": 0,
    "transitions": []
  },
  "childState": {},
  "terminal": false
}
```

## Failure classes

CONTROL_UNAVAILABLE:
replay descriptor cannot resolve.

RUNTIME_LOST:
provider runtime/frame disappeared.

PROTOCOL_REJECTED:
server response explicitly rejects action.

CI_ACCESS_BLOCK:
provider DEMO cannot load due environment-level protection.

STATE_AMBIGUOUS:
action succeeded but state fingerprint cannot distinguish transition.

NO_GAMEPLAY_EFFECT:
action caused no gameplay request and no state change.

Agents must not collapse these into generic "failed".
