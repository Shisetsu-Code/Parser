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
  stateToken?: string | null;
  roundId?: string | number | null;
  purchase?: {
    baseName?: string | null;
    selector?: Record<string, unknown>;
    raw?: unknown;
  } | null;
  raw: unknown;
};

type NormalizedAction = {
  name: string;
  kind: "spin" | "respin" | "freespin" | "bonus" | "pick" | "confirm" | "collect" | "continue" | "unknown";
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
