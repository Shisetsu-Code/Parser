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
