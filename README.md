# Parser

Small Playwright runner that discovers controls from the game runtime and presses them without screenshots, OCR or coordinate guessing.

Initial providers:

- **3Oaks / GameRunner**: inspects `GR.UI.view` and invokes the control's own click/pointer path. `GR.UI.Events` is only a fallback.
- **Pragmatic Play / UHT**: enumerates real `XTButton` components from `globalRuntime.sceneRoots`, maps their `eventToCode`, and presses `XTButton.OnPress(true/false)` / `OnClick()`. `XT.TriggerEvent` is only a fallback for known events.

The runner is **demo-only by default** and only opens official 3Oaks / Pragmatic hosts. Each game gets a fresh Playwright browser context.

## Install

```bash
npm install
npx playwright install chromium
```

## Run a list

Edit `targets.txt`:

```text
https://3oaks.com/game/3_aztec_temples | spin,buy_feature
https://www.pragmaticplay.com/en/games/sweet-craze/?gamelang=en&cur=USD | spin
```

Then:

```bash
npm start
```

Or specify default actions for lines without `|`:

```bash
npm start -- --actions spin
```

## Walk a provider catalog

```bash
npm start -- --catalog https://3oaks.com/games --actions spin --max-games 10
```

```bash
npm start -- --catalog https://www.pragmaticplay.com/en/games/ --actions spin --max-games 10
```

The catalog parser only collects links; the runtime parser still verifies the actual game provider after load.

## Results

Each game writes a JSON file under `results/` containing:

- detected provider and frame URL;
- runtime control inventory;
- actual press strategy used;
- network requests observed after every action;
- errors instead of guessed controls.

Example action record:

```json
{
  "action": "spin",
  "press": {
    "ok": true,
    "control": "StartSpin_Button",
    "event": "Evt_DataToCode_Pressed_Spin",
    "strategy": "XTButton.OnPress(true/false)"
  },
  "network": []
}
```

## Actions

### Pragmatic

Stable aliases currently included:

- `spin`
- `bet_inc` / `bet_increase`
- `bet_dec` / `bet_decrease`

Any other action name is also matched fuzzily against the runtime XTButton name and `eventToCode`. This is useful for discovering buy-feature or game-specific controls without hardcoding coordinates.

### 3Oaks

Stable aliases currently included:

- `spin`
- `buy_feature`
- `shop`
- `bets`
- `autoplay`
- `rules`
- `ante_bet`
- `booster`

The adapter first tries the control object itself, then its click emitter/pointer path, and only then the GameRunner event fallback.

## Why this works

The captured games expose reusable provider runtimes instead of only pixels. Pragmatic exposes `globalRuntime`, `XTButton`, `XT`, and `Vars`; 3Oaks GameRunner exposes `GR.UI.view` / `GR.UI.Events`. The parser uses those runtime objects directly and records the corresponding network delta after the interaction.

V1 deliberately does not invent canvas coordinates. If a control is not exposed by the provider runtime, it reports it as unresolved so a provider-specific adapter can be added cleanly.


## Execute demo purchases

Use `buy_all` to discover the purchase options exposed by the game and execute each available option once. Every option is loaded in a fresh browser context so a bought feature cannot prevent the next option from being tested.

```text
https://3oaks.com/game/3_aztec_temples | buy_all
https://www.pragmaticplay.com/en/games/sweet-craze/?gamelang=en&cur=USD | buy_all
```

Then run:

```bash
npm start
```

You can also run a catalog sample:

```bash
npm start -- --catalog https://3oaks.com/games --actions buy_all --max-games 1
```

Explicit purchase selection is available for diagnostics:

- `buy_1` = first visible purchase option
- `buy_2` = second visible purchase option
- `buy_3` = third visible purchase option

For 3Oaks the adapter opens the provider buy-feature control and routes the selected option through `app.board.buyFeature.actBuyFeature(option)`. For Pragmatic it invokes the real `FeaturePurchaseOption.OnClick()` component when available, including the confirm option, and falls back to the provider's purchase manager only when the button component is unavailable.

Purchase execution remains restricted to the official DEMO hosts allowed by the runner.
