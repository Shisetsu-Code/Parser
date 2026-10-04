# Belatra

status: provider-map
confidence: high for current core/runtime sample
sources:
- uploaded HAR: belatragames.com_Archive [26-10-03 20-34-36].har
- 7-game Belatra scenario HAR corpus captured 2026-10-03
- local official DEMO sessions
- common core and game-specific bundles
- CI bootstrap diagnostics

## Current implementation [IMPLEMENTED]

Provider-specific adapter:
`src/providers/belatra.js`

Capabilities:
- detects validated Belatra runtime via global `all_content`;
- reads provider configuration/state;
- hooks plaintext `ajaxQueue.post` before transport serialization;
- exposes provider protocol-event cursor/events to tree crawler;
- captures purchase-banner instance through `show_BuyBonusBanner`;
- enumerates Buy Bonus options separately from confirmation;
- exposes purchase-banner bet +/- controls;
- treats line count as exact configuration controls when `useBetDependOnLines=true`;
- delegates unresolved UI/Canvas interactions to trusted `generic-canvas`.

Current validated core module exports:
```text
all_content(2731).data
all_content(9337).unitmng
all_content(1129).ajaxQueue
```

These numeric IDs are version-specific ABI observations. The adapter validates the exports and must fail/fallback safely if the provider bundle changes.

## Transport [OBSERVED]

Primary gameplay endpoint:
POST /game

Observed request body:
```text
d=<opaque/encrypted-or-encoded-payload>&sid=<session>
```

Observed response:
JSON/object containing opaque d.

A single endpoint multiplexes many gameplay actions.
Endpoint path alone cannot classify:
- spin
- purchase
- bonus
- picker
- continue
- collect

## Plaintext pre-serialization layer [OBSERVED]

The common core exposes the semantic action before it becomes opaque transport:

```text
ajaxQueue.post(actionObject, ...)
    -> internal request queue
    -> POST /game
    -> d=<opaque>&sid=<session>
```

This is now the preferred source of truth.

Known plaintext action names/fields include:
- q
- name
- att
- info
- setting

Observed q values include:
- play
- enter
- finish
- savePlayerChoice

The parser records these provider protocol events separately from opaque network requests.

Do not attempt to decode d when a validated plaintext hook is available.

## Configuration state [OBSERVED]

Belatra core exposes:
- data.gs.nlines
- data.gs.linesAssortment
- data.gs.betPerLine
- data.gs.betPerGame
- data.gs.betAssortment
- unitmng.tGame.useBetDependOnLines

When `useBetDependOnLines=true`, line count is a structural state dimension.

Legacy of Doom proves:
- line selection changes total bet calculation;
- feature/payout code references `nlines * betPerLine`;
- game-specific tables are indexed by `nlines-1`;
- 1..10 line configurations must not be deduplicated into one purchase state.

The provider adapter emits exact replayable `BELATRA_CONFIG` controls for line values.

## Purchase model [OBSERVED]

Belatra has both single and multi-purchase banners.

Relevant runtime state:
- unitmng.tGame.justBuyBonusSelectType
- unitmng.tGame.justBuyBonusSelectType_AUTOBUY
- data.gs.buyBonus
- buyTotalBetK / buyTotalBetK_inside
- purchase bet limit state

Multi-buy flow can be:

```text
OPEN BUY
-> SELECT OPTION
-> optionally change purchase bet
-> START / YES / BUY confirmation
-> feature
```

Selection and confirmation are separate actions.

The adapter captures the active Buy Bonus banner and exposes:
- `BELATRA_BUY_OPTION`
- `BELATRA_BUY_CONFIRM`
- `BELATRA_BUY_BET`

Do not mark an option click as a completed purchase.

## Semantic selection/picker model [OBSERVED]

Several features send explicit plaintext choices:

```json
{
  "q": "savePlayerChoice",
  "name": "Bonus2",
  "att": 0,
  "info": 3
}
```

Interpretation:
- name: selection family/state
- att: attempt/step
- info: selected option ID

Examples:
- Lazy Monkey Bonus2: repeated rope choices
- Lazy Monkey Bonus3: bag choices
- 4 Secrets of Aladdin: Gems choices

Each `(name, att)` is a selection state.
Distinct `info` values are sibling branches.

Wait for the result of one `savePlayerChoice` before issuing another.

## Interstitial continuation [OBSERVED]

Belatra games can expose `PRESS TO CONTINUE` / click-to-continue states.

Jackpot Pagoda demonstrates:
- automatic progression may dismiss the state;
- manual input can also dismiss it;
- timeout behavior can coexist with manual continuation.

Required ordering:
1. observe automatic activity;
2. wait until quiet;
3. only if still blocked, branch a trusted continuation input.

## Scenario corpus

See:
`docs/ai/providers/BELATRA_SCENARIOS.md`

Covered:
- 4 Secrets of Aladdin
- Irish Thunder
- Halloween Crystals
- X-Mas Gifts
- Legacy of Doom
- Lazy Monkey
- Jackpot Pagoda

The corpus intentionally covers:
- single purchase;
- multi-purchase;
- option + explicit submit;
- mutable purchase bet;
- line-dependent purchase configuration;
- repeated internal picks;
- click-to-continue;
- automatic continuation.

## Normalized state

Suggested shape:

```json
{
  "provider": "belatra",
  "phase": "base|configuration|purchase|selection|feature|terminal|unknown",
  "terminal": null,
  "availableActions": [],
  "configuration": {
    "nlines": null,
    "betPerLine": null,
    "betPerGame": null
  },
  "purchase": {
    "selectedOption": null,
    "confirmRequired": null
  },
  "protocol": {
    "lastAction": null
  },
  "raw": {}
}
```

## CI behavior [OBSERVED]

GitHub Actions can discover and navigate to direct official demo URLs under demo.bltrm.com.

The GitHub-hosted runner can receive Cloudflare security verification / Turnstile before the game runtime.

Classification:
CI_ACCESS_BLOCK

This is not evidence that the Belatra runtime adapter fails locally.

Do not attempt to bypass provider anti-bot/security verification.

## Unknowns

- universal stability of current `all_content` module IDs across future core builds;
- complete generic terminal field across all Belatra game families;
- all possible q values;
- whether monetary bet variation changes feature topology in every line-dependent title;
- complete semantic discovery of all Canvas-only selection option IDs without runtime metadata.

Preserve raw plaintext protocol events and opaque /game deltas.
