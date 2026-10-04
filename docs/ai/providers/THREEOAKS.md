# 3Oaks

status: provider-map
confidence: medium-high
sources:
- repository runtime adapter
- live official DEMO tests
- GameRunner bundle/runtime inspection

## Runtime contract [IMPLEMENTED/OBSERVED]

Primary runtime:
window.GR

Primary UI:
GR.UI.view

Common controls observed:
- spin
- buy_feature
- shop_button
- total_bet
- bets
- bets_menu
- autogame
- autogame_menu
- ante_bet
- booster
- rules

Invocation preference:
1. target.click()
2. click emitter emit/dispatch/trigger/fire
3. pointerdown/pointerup
4. GR.UI.Events fallback

## Purchase runtime evidence [OBSERVED]

Runtime/bundle patterns:
- app.board.buyFeature.actBuyFeature(index)
- app.buyFeature._components
- button1/button2/button3
- buyFeaturePopup
- _availableBuyBonus
- buyFeaturePrice
- selected_mode / available buy bonus state

Known model:
open buy_feature -> enumerate exposed purchase components -> select one -> observe protocol/runtime state.

## State mapping [IMPLEMENTED PARTIAL]

Current adapter snapshots:
- spin disabled/state
- buy_feature disabled/selected
- buy popup visible
- selected mode
- selected Flow fields

Known deficiency:
GR.UI.view may remain unchanged while an internal modal/popup changes.

Therefore state hashing must include provider internal buyFeature/Flow state when available.

## Live test findings

Multiple unseen titles loaded and replayed with zero replay failures.

Common observation:
buy_feature can produce request/state effects while base GR.UI.view inventory remains identical.

This proves:
control inventory alone is not sufficient state identity for 3Oaks.

## Continuation

Do not assume buy -> terminal.

Features may require provider-specific:
- respin
- collect
- hold-and-spin continuation
- other runtime controls

Prefer explicit runtime model/Flow over UI labels.

## Normalized protocol proposal

```json
{
  "provider": "3oaks",
  "phase": "base|purchase|feature|unknown",
  "terminal": null,
  "availableActions": [],
  "selectedMode": null,
  "buyOptions": [],
  "flowState": {},
  "raw": {}
}
```

## Unknowns

- One universal network serializer for all 3Oaks studios/families.
- Stable cross-game mapping for internal buyFeature components.
- Complete terminal-state map.

Do not hardcode one game family as provider-wide behavior.
