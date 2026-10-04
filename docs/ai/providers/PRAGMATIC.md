# Pragmatic Play

status: provider-map
confidence: high
sources:
- repository runtime adapter
- live official DEMO tests
- uploaded HAR: www.pragmaticplay.com_Archive [26-10-03 20-41-24].har
- earlier DEMO evidence captured by Parser/Tester workflows

## Runtime contract [IMPLEMENTED]

Primary globals:
- globalRuntime
- XT
- Vars
- XTButton

Control discovery:
globalRuntime.sceneRoots -> GetComponentsInChildren(XTButton, true)

Common invocation:
- OnPress(true), OnPress(false)
- OnClick()

Feature purchase classes observed:
- FeaturePurchaseOption
- FeaturePurchaseV2
- FeaturePurchaseManager
- BuyFeature_InterfaceLink
- BuyFeature_BetButtons

Known spin event:
Evt_DataToCode_Pressed_Spin

## Transport [OBSERVED]

Gameplay endpoint family:
POST .../gs2c/.../gameService

Common request actions:
- action=doInit
- action=doSpin
- action=doBonus

Relevant fields observed across evidence:
- pur
- bgid
- ind
- end
- fs / fsmax
- na
- purchased feature state encoded in provider response

## Critical branch model [OBSERVED + INFERRED]

A purchase is not necessarily equivalent to one feature mode.

Mission Fishin evidence:
symbol=vs10bbfmission

Uploaded HAR contains:
- doInit
- doSpin

Bundle/runtime evidence associated with same capture shows a post-purchase internal selection tree.

Observed model:
```text
FEATURE purchase
  -> internal selection
     -> FREE SPINS
     -> STACK THE CASH
```

These are not necessarily independent pur values.

Additional bonus pick systems observed in bundle:
- BonusPick_BBFM
- FSPicker_BBFM
- Evt_ToServer_BonusPickItem
- doBonus
- ind=<choice>

The agent must model:
purchase -> response -> possible selector -> doBonus(ind) -> wait -> possible next picker/feature state

## Waiting invariant [OBSERVED]

Provider code includes guard behavior equivalent to:
do not pick again before the prior bonus result is received.

Therefore:
after doBonus or purchase selection, WAIT for response/state before sending another pick.

## Purchase discovery

Do not assume purchase identity is:
pur=0, pur=1, ...

A provider game can expose:
- one purchase that opens a second-level choice
- multiple purchase options
- pseudo controls such as Rebuy
- confirm controls whose mutable purchaseIndex must not be used as sole stable identity

## Known implementation issue history

Sweet Craze demonstrated:
- FeaturePurchaseOption controls can exist inactive then become active
- O_0/O_1 can be real option controls
- ConfirmBuy/BuyWindow are transient
- purchaseIndex on transient controls can mutate
- strict name+purchaseIndex resolution can fail replay

Stable transient-control matching should prefer:
name + type + active state
with purchaseIndex as contextual state, not mandatory identity for confirm/window controls.

## Normalized protocol proposal

```json
{
  "provider": "pragmatic",
  "phase": "selection|feature|base|unknown",
  "terminal": null,
  "availableActions": [],
  "bonusGameId": null,
  "selectionIndex": null,
  "purchaseIndex": null,
  "raw": {}
}
```

## Unknowns

- Complete generic terminal rule across every Pragmatic game family.
- Universal mapping from UI purchase option to pur value.
- Universal semantics for every bgid family.

Preserve raw protocol fields.


## 20-game purchase audit — 2026-10-04

Audit implementation:
`scripts/pragmatic-purchase-audit.mjs`

Validation order:
1. server `doInit` response `purInit` for the actual DEMO session;
2. runtime `FeaturePurchaseOption` / `FeaturePurchaseV2` / `FeaturePurchaseManager`;
3. Parser `listPurchases()`.

`purInit` is authoritative for purchases enabled in the current session/configuration.
Runtime components can exist as placeholders even when the server exposes zero purchases.

Final v3 sample:

| game | Parser | server purInit | result |
| --- | ---: | ---: | --- |
| Gates of Olympus 2500 | 4 | 4 | PASS |
| Triple Hop Pots | 0 | 0 | PASS |
| Helios – Triple Sun | 2 | 2 | PASS |
| Eternal Diamonds | 3 | 3 | PASS |
| Lucky Drums 88 | 1 | 1 | PASS |
| Ra vs Osiris | 4 | 4 | PASS |
| Gates of Olympus POP | 1 candidate | 0 | MISMATCH / runtime placeholder |
| Heart of Venus | 3 | 3 | PASS |
| Eastern Fury | 2 | 2 | PASS |
| Jelly Express | 2 | 2 | PASS |
| Fortune of Olympus | 2 | 2 | PASS |
| Sweet Rush Bonanza | 2 | 2 | PASS |
| Big Bass Bonanza 1000 | 2 | 2 | PASS |
| Gates of Olympus Super Scatter | 2 | 2 | PASS |
| Sweet Bonanza Super Scatter | 2 | 2 | PASS |
| Gates of Hades | 2 | 2 | PASS |
| The Dog House Megaways 1000 | 3 | 3 | PASS |
| Starlight Princess Super Scatter | 2 | 2 | PASS |
| Mahjong Wins Super Scatter | 1 | 1 | PASS |
| Bandit Megaways | 2 | 2 | PASS |

Result:
- 19/20 exact matches after parser fixes.
- 1 false-positive runtime candidate: Gates of Olympus POP.
- zero audit execution errors.

Bugs discovered and fixed during the audit:
- transient `purchaseOptionIsAvailable=false` must not mean the option does not exist;
- `FeaturePurchaseV2.purchaseOptions` may populate asynchronously;
- some games instantiate purchase UI only after the Buy Feature menu opens;
- controls with negative `purchaseIndex` such as Rebuy are not independent purchase options.

Remaining rule:
when `purInit` is explicitly absent/zero, server truth must override empty/placeholder runtime purchase components.


## Second random 20-game purchase audit — 2026-10-04

Audit:
`scripts/pragmatic-purchase-audit-more20.mjs`

This audit runs a reproducible seeded random selection from a broad pool of official Pragmatic titles, excluding historical project coverage and the first 20-game audit. Invalid/non-demo candidates are skipped until 20 valid Pragmatic runtimes are collected.

The normal Parser now captures `doInit` server `purInit` and exposes it to the Pragmatic adapter as session truth. `listPurchases()` uses that server count to:
- reject runtime placeholders when `purInit=0`;
- wait for lazy `FeaturePurchaseV2` initialization;
- open Buy Feature UI when required;
- exclude negative/transient indices such as Rebuy;
- synthesize server-declared option descriptors only when the server declares an option but the UI handler has not materialized yet.

Final sample:

| game | Parser | server purInit | result |
| --- | ---: | ---: | --- |
| Great Rhino Megaways | 1 | 1 | PASS |
| Wild Beach Party | 1 | 1 | PASS |
| Wild Depths | 0 | 0 | PASS |
| Big Bass Bonanza Keeping It Reel | 1 | 1 | PASS |
| John Hunter and the Tomb of the Scarab Queen | 0 | 0 | PASS |
| Diamond Strike | 0 | 0 | PASS |
| Gates of Olympus | 1 | 1 | PASS |
| Floating Dragon | 0 | 0 | PASS |
| Empty the Bank | 1 | 1 | PASS |
| Big Bass Floats My Boat | 2 | 2 | PASS |
| Wild West Gold Blazing Bounty | 2 | 2 | PASS |
| Fruit Party 2 | 1 | 1 | PASS |
| Down the Rails | 0 | 0 | PASS |
| 888 Dragons | 0 | 0 | PASS |
| Gems Bonanza | 1 | 1 | PASS |
| Cash Elevator | 0 | 0 | PASS |
| Drago Jewels of Fortune | 1 | 1 | PASS |
| Pyramid Bonanza | 0 | 0 | PASS |
| Sweet Bonanza Xmas | 0 | 0 | PASS |
| Starlight Princess | 1 | 1 | PASS |

Result:
- 20/20 exact Parser vs server `purInit` matches.
- 0 mismatches.
- 0 skipped/invalid candidates in the final selected 20.
- 0 runtime errors.

Combined evidence:
- first audit v3: 19/20 exact before server-authority integration; Gates of Olympus POP exposed a runtime placeholder with server `purInit=0`;
- server-authority rule was then integrated into the normal Parser;
- second audit: 20/20 exact on a distinct sample.

Conclusion:
for Pragmatic purchase count, server `doInit.purInit` is authoritative for the current session. Runtime controls are implementation handles, not purchase-count truth.


## Purchase scope clarification

Project-level PURCHASE semantics are broader than Pragmatic `purInit`.

`purInit` validates Feature Purchase / Buy Feature options only.

The total PURCHASE inventory for a game must additionally include separately priced runtime controls such as:
- Ante Bet / Bonus Chance / Double Chance
- Super Spin / enhanced spin modes
- boosters or other extra-cost modifiers

Therefore the earlier 20-game `purInit` audits validate the Buy Feature subset, not the complete paid-purchase count under the project definition.

Normalized representation:
```text
PURCHASE
  subtype=buy_feature | ante_bet | chance | super_spin | booster | other_paid_modifier
  resulting_feature=free_spins | bonus | respin | enhanced_chance | enhanced_spin | unknown
```
