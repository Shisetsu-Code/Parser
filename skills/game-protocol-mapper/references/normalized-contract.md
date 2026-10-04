# Normalized Provider Contract

An analyzer should conceptually expose:

```ts
type NormalizedProviderState = {
  provider: string;
  protocolFamily?: string | null;
  phase: "base" | "purchase" | "confirmation" | "selection" | "feature" | "terminal" | "unknown";
  terminal: boolean | null;
  automaticActivity: boolean | null;
  selectionRequired: boolean | null;
  availableActions: NormalizedAction[];
  configuration?: {
    structural?: boolean;
    dimensions?: Record<string, string | number | boolean | null>;
    derived?: Record<string, string | number | boolean | null>;
  } | null;
  stateToken?: string | null;
  roundId?: string | number | null;
  purchase?: {
    baseName?: string | null;
    selector?: Record<string, unknown>;
    confirmRequired?: boolean | null;
    raw?: unknown;
  } | null;
  raw: unknown;
};

type NormalizedAction = {
  name: string;
  kind: "configure" | "spin" | "respin" | "freespin" | "purchase-select" | "purchase-toggle" | "purchase-confirm" | "bonus" | "pick" | "confirm" | "collect" | "continue" | "unknown";
  selector?: Record<string, unknown>;
  raw?: unknown;
};
```

## Analyzer responsibilities

requestMatches(request): boolean

parseRequest(request):
- operation candidate
- purchase selector
- state token supplied
- raw payload

parseResponse(response):
- terminal
- next explicit actions
- next state token
- round/feature state
- raw payload

normalize(request,response,runtimeSnapshot):
- merge evidence without guessing

## Orchestrator responsibilities

The tree crawler:
- executes controls
- captures network delta
- calls analyzer
- waits/branches/replays
- deduplicates state

The analyzer:
- never clicks UI
- never opens browser pages
- never decides coordinates

## Unknown-safe rule

null means unknown.

Never use false to mean unknown.
Never use empty [] to mean "there are definitely no actions" unless provider evidence establishes that.

## Replay token rule

State tokens must be retained only as live session state.
Never persist captured token values as constants or examples.
Examples:
- BGaming state_lock
- provider session IDs
- launch tokens
- Pragmatic mgckey session
- Belatra sid


## Structural configuration contract

If configuration is structural, the tree crawler must treat each distinct dimension value as a distinct replay state.

Observed example:
```json
{
  "configuration": {
    "structural": true,
    "dimensions": {"nlines": 10},
    "derived": {"betPerLine": 1, "betPerGame": 10}
  }
}
```

Changing a configuration value is an action and should have a replay descriptor such as:
```json
{
  "kind": "BELATRA_CONFIG",
  "configKey": "nlines",
  "configValue": 10
}
```

## Provider protocol-event contract

Providers may expose semantic client-side events that exist before network serialization.

Optional adapter methods:
```ts
protocolCursor(frame): Promise<number | null>
protocolEvents(frame, since: number): Promise<unknown[]>
```

Tree edges should retain these events separately from raw network requests.


## Purchase definition

A PURCHASE is any user-selectable action that adds cost beyond a normal/base spin.

This includes, when separately priced:
- Buy Feature / Bonus Buy
- Free Spins Buy
- Ante Bet / Bonus Chance / Double Chance
- Super Spin / Enhanced Spin
- Booster / feature multiplier
- extra ball / extra draw
- any other paid modifier layered on top of the base spin

The resulting feature is separate metadata, not a different top-level action category.

Example:
```json
{
  "kind": "purchase-select",
  "purchase": {
    "subtype": "ante_bet",
    "costModel": "extra_per_spin",
    "resultingFeature": "increased_feature_chance"
  }
}
```

Do not classify a paid Ante Bet as configuration merely because it changes spin behavior.
A free structural setting such as paylines/line-count remains configuration.
