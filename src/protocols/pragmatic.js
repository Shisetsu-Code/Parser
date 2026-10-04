function parseForm(text) {
  const out = {};
  if (!text || typeof text !== 'string') return out;

  try {
    const params = new URLSearchParams(text);
    for (const [key, value] of params.entries()) out[key] = value;
  } catch {}

  return out;
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parsePragmaticExchange(responseSummary) {
  if (!responseSummary) return null;

  const request = parseForm(responseSummary.requestPostData || '');
  const action = request.action || null;

  if (!['doInit', 'doSpin', 'doBonus', 'doCollect'].includes(action)) {
    return null;
  }

  const response = parseForm(responseSummary.body || '');

  return {
    action,
    symbol: request.symbol ?? null,
    pur: request.pur ?? request.puri ?? null,
    ind: request.ind ?? null,
    lInd: request.lInd ?? null,

    na: response.na ?? null,
    fs: response.fs ?? null,
    fsmax: response.fsmax ?? null,
    bgid: response.bgid ?? null,
    bgt: response.bgt ?? null,
    end: response.end ?? null,
    bw: response.bw ?? null,
    rs: response.rs ?? null,
    rs_c: response.rs_c ?? null,
    rs_m: response.rs_m ?? null,
    trail: response.trail ?? null,

    request,
    response
  };
}

export function latestPragmaticExchange(responseSummaries) {
  for (let i = (responseSummaries?.length ?? 0) - 1; i >= 0; i--) {
    const exchange = parsePragmaticExchange(responseSummaries[i]);
    if (
      exchange &&
      ['doSpin', 'doBonus', 'doCollect'].includes(exchange.action)
    ) {
      return exchange;
    }
  }

  return null;
}

export function classifyPragmaticState(exchange) {
  if (!exchange) {
    return {
      phase: 'unknown',
      terminal: null,
      next: 'unknown',
      selectionRequired: null
    };
  }

  const na = String(exchange.na || '').toLowerCase();
  const fs = finite(exchange.fs);
  const fsmax = finite(exchange.fsmax);
  const end = finite(exchange.end);
  const currentRespin = finite(exchange.rs_c);
  const maxRespins = finite(exchange.rs_m);

  const unfinishedBonus =
    na === 'b' &&
    (
      exchange.bgid != null ||
      end !== 1
    );

  const freeSpins =
    fsmax != null &&
    fsmax > 0 &&
    fs != null &&
    fs < fsmax;

  const multiCascade =
    String(exchange.rs || '').toLowerCase() === 'mc';

  const trailPending =
    exchange.trail != null &&
    /pending|feature/i.test(String(exchange.trail));

  const respinPending =
    maxRespins != null &&
    maxRespins > 0 &&
    (
      currentRespin == null ||
      currentRespin < maxRespins
    );

  if (na === 'b' || unfinishedBonus) {
    return {
      phase: 'feature',
      terminal: false,
      // The transport alone cannot distinguish a player picker from a bonus
      // respin/init. Runtime evidence must resolve this.
      next: respinPending ? 'bonus-respin' : 'bonus',
      selectionRequired: null,
      bonusGameId: exchange.bgid,
      bonusGameType: exchange.bgt
    };
  }

  if (na === 'c') {
    return {
      phase: 'feature',
      terminal: false,
      next: 'collect',
      selectionRequired: false
    };
  }

  if (na === 's' && (freeSpins || multiCascade || trailPending)) {
    return {
      phase: 'feature',
      terminal: false,
      next: 'spin',
      selectionRequired: false,
      freeSpin: fs,
      freeSpinMax: fsmax,
      cascade: multiCascade,
      trailPending
    };
  }

  if (na === 's') {
    return {
      phase: 'base',
      terminal: true,
      next: 'spin',
      selectionRequired: false
    };
  }

  return {
    phase: 'unknown',
    terminal: null,
    next: 'unknown',
    selectionRequired: null
  };
}

export function summarizePragmaticPurchaseEntry(exchange) {
  if (!exchange) return null;

  return {
    action: exchange.action,
    purchaseIndex:
      exchange.pur == null
        ? null
        : finite(exchange.pur),
    nextAction: exchange.na ?? null,
    state: classifyPragmaticState(exchange)
  };
}
