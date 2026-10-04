# BGaming

status: provider-map
confidence: high for sampled protocol families
sample_count: 9 HAR captures

## Core result [OBSERVED]

BGaming is NOT one serializer.

At least two gameplay protocol families are present in the captured sample.

### Family A: command

Endpoint shape:
POST /api/<Game>/<numeric>/<session>

Request:
```json
{
  "command": "init|spin|respin|freespin|close_session",
  "options": {},
  "extra_data": {}
}
```

Response contains provider flow state such as:
```json
{
  "flow": {
    "state": "ready|closed|respin|freespins",
    "command": "spin|respin|freespin|init",
    "available_actions": ["init","spin"],
    "purchased_feature": {}
  }
}
```

Continuation source of truth:
flow.available_actions

Examples:
- ["init","respin"] => feature requires respin
- ["init","freespin"] => feature requires freespin
- ["init","spin"] with closed/ready => feature terminal/base

### Family B: JSON-RPC

Endpoint:
POST /api

Request:
```json
{
  "jsonrpc": "2.0",
  "method": "init|play",
  "params": {
    "req": {},
    "state_lock": "...",
    "token": "..."
  }
}
```

Response evidence includes:
- result.final
- result.state_lock
- game mode fields in some titles

Continuation:
- final=false => unfinished round/feature
- final=true => round terminal
- state_lock MUST be updated from response before next play

state_lock is replay state, not metadata.

## Purchase selector diversity [OBSERVED]

Never reduce purchase identity to purchased_feature alone.

### feature_id selector
Chicken Fire:
```json
{"purchased_feature":"buy_bonus","feature_id":"buy_bonus"}
{"purchased_feature":"buy_bonus","feature_id":"buy_super_bonus"}
{"purchased_feature":"buy_bonus","feature_id":"buy_ultra_bonus"}
```
Also observed:
{"purchased_feature":"buy_chance"}

### purchased_feature_level selector
St Patrick's Pots Hold & Win:
```json
{"purchased_feature":"bonus_buy","purchased_feature_level":"0"}
{"purchased_feature":"bonus_buy","purchased_feature_level":"1"}
{"purchased_feature":"bonus_buy","purchased_feature_level":"2"}
```
Also:
{"purchased_feature":"bonus_chance"}

### boolean selector
Red Hot Chilli Chickens:
```json
{"purchased_feature":"bonus_buy","isSuperBonus":false}
{"purchased_feature":"bonus_buy","isSuperBonus":true}
```

### distinct purchased_feature names
Aloha King Elvis:
- bonus_buy
- freespin_buy
- bonus_chance
- freespin_chance

Other sampled names:
- freespin_buy
- freespin_chance
- bonus_buy
- bonus_chance
- buy_bonus
- buy_chance

## HAR sample mapping [OBSERVED]

### Divine Queen: Heart of Ice
family: command
requests:
- freespin_buy
- freespin_chance
continuation:
spin -> state=freespins -> command=freespin until base/terminal

### Alien Fruits 3
family: command
requests:
- bonus_buy
- bonus_chance
important:
bonus_buy can return directly to state=closed with available_actions=["init","spin"].
A purchase does not guarantee a long feature sequence.

### Reel of Ra
family: command
requests:
- bonus_buy
- bonus_chance
bonus_buy observed entering freespins.

### Chicken Fire
family: JSON-RPC
requests:
- buy_chance
- buy_bonus + feature_id in {buy_bonus,buy_super_bonus,buy_ultra_bonus}
continuation:
final=false and changing state_lock across play calls.

### St Patrick's Pots Hold & Win
family: command
requests:
- bonus_buy + purchased_feature_level in {0,1,2}
- bonus_chance
continuation:
state=respin + available_actions=["init","respin"]

### Red Hot Chilli Chickens
family: JSON-RPC
requests:
- bonus_buy + isSuperBonus false/true
continuation:
final=false then later final=true.

### Big Bucks Saloon
family: JSON-RPC
request:
- buy_bonus
continuation:
multiple play calls with changing state_lock while final=false.

### Aloha King Elvis
family: command
requests:
- bonus_buy
- freespin_buy
- bonus_chance
- freespin_chance
continuation:
bonus_buy -> respin
freespin_buy -> freespin

### Mystic Reels
family: JSON-RPC
requests:
- buy_chance
- buy_bonus
response modes observed:
- BASIC
- RESPIN_BUY
- BONUS_BUY
buy_bonus observed with final=false and changing state_lock.

## UI/runtime implications

Sample includes UI patterns containing:
- Continue / Click to continue
- pick/select/choice semantics
- internal feature selection

Do not assume every user-visible continuation generates a distinct purchase request.

Generic control traversal remains necessary for interstitials that exist only in client state.

Use trusted Playwright input for Canvas/WebGL.

## Analyzer algorithm

```text
detect family per request

if command family:
  parse command/options
  parse response.flow
  next = flow.available_actions
  terminal when feature has returned to base spin state

if JSON-RPC:
  parse method/params.req
  preserve complete purchase selector object
  replace state_lock after every response
  if final=false: continue
  if final=true: terminal

always:
  keep full purchase selector
  do not normalize away feature_id / purchased_feature_level / isSuperBonus
```

## Recommended normalized purchase object

```json
{
  "kind": "purchase",
  "baseName": "bonus_buy",
  "selector": {
    "feature_id": null,
    "purchased_feature_level": null,
    "isSuperBonus": null
  },
  "raw": {}
}
```

## Evidence files

See docs/ai/EVIDENCE_MANIFEST.json.

## Unknowns

- Complete set of BGaming protocol families outside captured sample.
- Generic meaning of every mode string.
- Whether all JSON-RPC games use final/state_lock identically.
- Exact protocol semantics for every click-to-continue/picker screen.

Use captured response state over assumptions.
