# Belatra Scenario Matrix

status: observed-scenario-corpus
audience: AI agents
provider: Belatra
sample_count: 7 HAR captures
transport: POST /game with opaque d/sid after client-side plaintext action construction

## Global runtime ABI observed

The sampled runtime exposes a global webpack require function:

```text
globalThis.all_content
```

Validated current core modules:

```text
all_content(2731).data
all_content(9337).unitmng
all_content(1129).ajaxQueue
```

These numeric module IDs are version-specific ABI observations, not universal Belatra constants.
Adapters MUST validate exports before use and fall back safely when the bundle changes.

The current provider adapter uses these validated modules to:
- read game configuration/state;
- capture buy-menu state;
- traverse line configuration;
- hook ajaxQueue.post before /game payload serialization.

## Plaintext transport hook

Observed core behavior:

```text
ajaxQueue.post(plaintextAction, callback, errorCallback)
    -> queue/add request
    -> POST /game
    -> opaque network body d=<...>&sid=<...>
```

Therefore plaintextAction is higher-value protocol evidence than attempting to decode d.

Known q values include:
- play
- enter
- finish
- savePlayerChoice

Record complete plaintext action objects after redacting live credentials/session identifiers.

## Scenario: 4 Secrets of Aladdin

family: aladdin
HAR: belatragames.com_Archive [26-10-03 23-08-58](1).har

OBSERVED capabilities:
- single Buy Bonus banner family;
- purchase price changes with current bet;
- bet + / - inside purchase banner;
- explicit YES/confirm step;
- internal Gems selection;
- savePlayerChoice plaintext action.

Observed picker form:

```json
{
  "q": "savePlayerChoice",
  "name": "Gems",
  "att": "<attempt>",
  "info": "<selected-id>"
}
```

Traversal requirement:

```text
OPEN BUY
-> configure purchase bet if needed
-> CONFIRM
-> wait
-> if Gems picker:
     branch each available selection
     send exactly one choice
     wait for result
     repeat on next attempt until feature terminal
```

Selection identity is (name, att, info), not canvas coordinate.

## Scenario: Irish Thunder

family: irish
HAR: free-slot.belatragames.com_Archive [26-10-03 23-15-25].har

OBSERVED:
- BannerBuyBonusMultiple;
- 3 purchase option buttons;
- option changes unitmng.tGame.justBuyBonusSelectType;
- separate START confirmation;
- purchase-banner bet adjustment;
- three buy-bonus RTP entries;
- optional savePlayerChoice path for manually finishing free games.

Purchase UI labels correspond to Wild-on-reel variants:
- Wild on 2 reel
- Wild on 3 reel
- Wild on 4 reel

Required branch model:

```text
BUY_MENU
├─ option 0 -> CONFIRM START
├─ option 1 -> CONFIRM START
└─ option 2 -> CONFIRM START
```

Option selection MUST NOT be treated as completed purchase.

## Scenario: Halloween Crystals

family: digger
HAR: free-slot.belatragames.com_Archive [26-10-03 23-16-17].har

OBSERVED:
- BannerBuyBonusMultiple;
- 3 purchase options;
- justBuyBonusSelectType;
- explicit START confirmation;
- purchase-banner bet adjustment;
- scatter-count-oriented option UI;
- PRESS TO CONTINUE assets/state support.

Traversal:
select option -> observe selected state -> confirm -> settle -> continue/interstitial if required.

## Scenario: X-Mas Gifts

family: digger_xmas
HAR: free-slot.belatragames.com_Archive [26-10-03 23-17-20].har

OBSERVED:
- same multi-buy structural family as digger;
- 3 purchase options;
- separate selection and START;
- mutable purchase bet;
- PRESS TO CONTINUE states.

Do not merge with Halloween Crystals by title/family assumption; reuse runtime capability detection only.

## Scenario: Legacy of Doom

family: book_legacy
HAR: free-slot.belatragames.com_Archive [26-10-03 23-19-36].har

CRITICAL structural configuration case.

OBSERVED runtime:
- useBetDependOnLines=true;
- mutable gs.nlines;
- gs.linesAssortment;
- gs.betPerLine;
- gs.betPerGame;
- line increment/decrement controls;
- calcBetPerGameByFormula(betPerLine, nlines);
- payout/feature code contains multiplication by nlines * betPerLine;
- timing/paytable behavior indexes arrays by nlines-1 with 10 entries;
- single Buy Bonus banner;
- purchase bet controls and explicit confirm.

User-verified DEMO range:
- minimum lines: 1
- maximum lines: 10

Required state identity:

```json
{
  "configuration": {
    "nlines": 1,
    "betPerLine": "...",
    "betPerGame": "..."
  },
  "purchase": {
    "selectedOption": "...",
    "confirmRequired": true
  }
}
```

Required exploration:

```text
for nlines in linesAssortment:
  establish configuration state nlines
  observe resulting betPerLine/betPerGame/bet assortment
  open purchase
  capture purchase cost/state
  execute purchase branch
  traverse resulting feature to terminal
```

Do NOT dedupe states across different nlines.

Bet dimension policy:
- nlines is proven structural and MUST be enumerated;
- betPerLine/betPerGame MUST be part of state;
- do not automatically cross-product every monetary denomination unless evidence shows topology/selection/outcome-state semantics differ;
- if changing bet changes available purchase options, feature state, server selector, or non-scalar outcome semantics, promote bet to a structural branch dimension.

OBSERVED:
the payout/value formulas depend on nlines and betPerLine.

UNKNOWN:
whether the random-result distribution/topology changes across all line counts beyond normal mathematical scaling.
Do not assert equivalence.

## Scenario: Lazy Monkey

family: lazy_monkey
HAR: belatragames.com_Archive [26-10-03 23-04-41](1).har

Strong semantic selection evidence.

Bonus2:
- 5 rope choices, IDs 1..5;
- multiple attempts;
- selected choices are excluded from later choices;
- explicit plaintext action:

```json
{
  "q": "savePlayerChoice",
  "name": "Bonus2",
  "att": "<attempt-index>",
  "info": "<rope-id>"
}
```

Bonus3:
- 2 bag choices, IDs 0 and 1;
- explicit plaintext action with same q/name/att/info structure.

Required traversal:
- model each attempt as a new SELECTION state;
- branch all currently available info values;
- replay siblings from clean parent path;
- wait for response before next choice;
- never collapse repeated attempts by identical screen appearance alone.

## Scenario: Jackpot Pagoda

family: jackpot_pagoda
HAR: belatragames.com_Archive [26-10-03 23-07-55](1).har

OBSERVED:
- Hold & Win purchase mode;
- justBuyBonusSelectType_AUTOBUY support;
- multi-level bonus state;
- PRESS TO CONTINUE interstitial;
- interstitial may auto-dismiss in history/autoplay paths;
- manual path accepts input and also has a later timeout.

Required continuation policy:

```text
when PRESS TO CONTINUE state appears:
  first observe/wait for automatic progression
  if state becomes quiet and remains blocked:
    expose continue input branch
    trusted click/start input
    observe next state
```

Do not immediately click every continuation screen; automatic behavior has priority.

## Generic Belatra capabilities derived from corpus

CONFIGURATION_DIMENSION:
- lines
- bet inside buy banner
- possibly other provider runtime configuration when it alters branch topology

PURCHASE_SELECTION:
- option selection changes client state

PURCHASE_CONFIRMATION:
- START/YES/BUY is a separate action after option selection

PLAINTEXT_ACTION:
- ajaxQueue.post payload before d serialization

FEATURE_SELECTION:
- savePlayerChoice with semantic fields

INTERSTITIAL_CONTINUE:
- click/start/tap may be required only after automatic progression settles

## Parser requirements

1. State hash includes configuration when structural.
2. replayDescriptor preserves configKey/configValue.
3. provider adapter can emit exact config controls.
4. purchase option and purchase confirm are distinct controls.
5. protocol events are captured separately from network requests.
6. automatic settle considers plaintext protocol-event activity.
7. selection events preserve q/name/att/info.
8. sibling selection branches are isolated.
9. opaque /game traffic remains retained for evidence correlation.
10. no game-title-specific branching is required for these behaviors.
