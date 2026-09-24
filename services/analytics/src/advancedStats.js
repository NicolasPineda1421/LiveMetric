// Estadística avanzada de los reportes: proyección de participación,
// momento de definición, integridad del acta y accesos sospechosos.
//
// Son funciones puras: reciben datos ya agregados (conteos por minuto,
// filas del libro de escrutinio, eventos de login) y nunca tocan la base
// de datos, igual que las de app.js (computeConcentration, wilsonCi95...).
// Así se pueden probar con casos armados a mano, sin sembrar actas ni
// eventos de auditoría (tablas append-only) en la base real.
//
// Criterio común: si no hay datos suficientes para que un número signifique
// algo, se devuelve un estado que lo dice ("insuficiente") en vez de un
// número engañoso. Y ninguna salida permite reconstruir votos individuales.

const { GENESIS_HASH, computeRecordHash } = require('./hashChain');

const MINUTE_MS = 60 * 1000;

const round1 = (x) => Number(x.toFixed(1));
const pct = (part, total) => (total > 0 ? round1((part / total) * 100) : 0);
// Participación en %, acotada a 100 como en /metrics/operational: por
// encima solo puede significar más votos que votantes activos (por ejemplo,
// alguien desactivado después de votar), no una participación real.
const turnoutPct = (votes, registered) => Math.min(100, pct(votes, registered));
const toMs = (date) => new Date(date).getTime();
const sumVotes = (rows) => rows.reduce((sum, r) => sum + r.votes, 0);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* ============================================================
 * 1. PROYECCIÓN DE PARTICIPACIÓN
 * ============================================================ */

// Antes de esto cualquier proyección es ruido: con el 2% de la jornada y
// 3 votos, un solo votante de más o de menos mueve el resultado decenas
// de puntos.
const PROJECTION_MIN_ELAPSED = 0.1;
const PROJECTION_MIN_VOTES = 10;
// Una elección anterior solo sirve de referencia si tuvo votos suficientes
// para que su curva tenga forma, y hacen falta al menos 2 para tener un
// rango en vez de un único caso.
const HISTORY_MIN_VOTES = 20;
const HISTORY_MIN_ELECTIONS = 2;
// Si a esta altura una elección anterior llevaba menos del 2% de sus votos,
// dividir por esa fracción dispara la proyección: se descarta esa curva.
const HISTORY_MIN_FRACTION = 0.02;
const CURVE_STEPS = 12;

// Fracción de los votos de una elección anterior emitidos hasta la misma
// altura relativa de su propia ventana (0 = apertura, 1 = cierre).
function cumulativeFraction({ start, end, minuteCounts }, relativeTime) {
  const startMs = toMs(start);
  const duration = toMs(end) - startMs;
  let total = 0;
  let upToThen = 0;
  for (const { minute, votes } of minuteCounts) {
    total += votes;
    if ((toMs(minute) - startMs) / duration <= relativeTime) upToThen += votes;
  }
  return total ? upToThen / total : 0;
}

// Proyecta la participación final de una elección en curso.
//   - Con al menos 2 elecciones anteriores comparables: "si esta jornada se
//     reparte como las anteriores". Para cada una, la fracción F de sus
//     votos que ya se había emitido a esta misma altura de la ventana da
//     una proyección votosHastaAhora / F; el valor central es la mediana y
//     el rango, el mínimo y el máximo entre ellas.
//   - Sin historial: "si el ritmo actual se mantiene", con un intervalo de
//     Poisson para los votos que faltan. Es optimista: en una jornada real
//     el ritmo suele bajar hacia el cierre (el frontend lo aclara).
function projectTurnout({ status, start, end, now, registered, minuteCounts, history = [] }) {
  const startMs = toMs(start);
  const endMs = toMs(end);
  const nowMs = toMs(now);
  const votes = sumVotes(minuteCounts);
  const elapsed = Math.min(1, Math.max(0, (nowMs - startMs) / (endMs - startMs)));

  const base = {
    registered,
    votesSoFar: votes,
    currentTurnoutPct: turnoutPct(votes, registered),
    elapsedPct: pct(elapsed, 1),
  };
  const votesUpTo = (momentMs) => sumVotes(minuteCounts.filter((m) => toMs(m.minute) <= momentMs));
  const stepTime = (i) => startMs + ((endMs - startMs) * i) / CURVE_STEPS;
  const actualCurve = (untilMs) => {
    const points = [];
    for (let i = 0; i <= CURVE_STEPS && stepTime(i) <= untilMs; i++) {
      points.push({ at: new Date(stepTime(i)).toISOString(), actualPct: turnoutPct(votesUpTo(stepTime(i)), registered), projectedPct: null });
    }
    return points;
  };

  if (status === 'scheduled' || nowMs <= startMs) {
    return { ...base, state: 'sin_iniciar', method: null, curve: [] };
  }
  if (status === 'closed' || nowMs >= endMs) {
    return {
      ...base,
      state: 'final',
      method: null,
      projectedVotes: votes,
      projectedTurnoutPct: base.currentTurnoutPct,
      interval: null,
      curve: actualCurve(endMs),
    };
  }
  if (elapsed < PROJECTION_MIN_ELAPSED || votes < PROJECTION_MIN_VOTES) {
    return {
      ...base,
      state: 'insuficiente',
      method: null,
      minimums: { elapsedPct: PROJECTION_MIN_ELAPSED * 100, votes: PROJECTION_MIN_VOTES },
      curve: actualCurve(nowMs),
    };
  }

  const projections = history
    .filter((h) => sumVotes(h.minuteCounts) >= HISTORY_MIN_VOTES)
    .map((h) => cumulativeFraction(h, elapsed))
    .filter((fraction) => fraction >= HISTORY_MIN_FRACTION)
    .map((fraction) => votes / fraction);

  let method;
  let central;
  let low;
  let high;
  if (projections.length >= HISTORY_MIN_ELECTIONS) {
    method = 'historico';
    central = median(projections);
    low = Math.min(...projections);
    high = Math.max(...projections);
  } else {
    method = 'ritmo_constante';
    const remaining = (votes / (nowMs - startMs)) * (endMs - nowMs);
    const margin = 1.96 * Math.sqrt(remaining);
    central = votes + remaining;
    low = votes + Math.max(0, remaining - margin);
    high = votes + remaining + margin;
  }
  // Nunca menos de lo que ya se votó (es un hecho, aunque haya más votos que
  // votantes activos) ni más votos que votantes habilitados.
  const bound = (v) => Math.round(Math.max(votes, Math.min(registered, v)));
  const projectedVotes = bound(central);

  // Curva: lo real hasta ahora y, desde ahora, una recta hacia el valor
  // proyectado al cierre (es una guía visual, no un pronóstico minuto a minuto).
  const future = [];
  for (let i = 0; i <= CURVE_STEPS; i++) {
    if (stepTime(i) <= nowMs) continue;
    const progress = (stepTime(i) - nowMs) / (endMs - nowMs);
    future.push({
      at: new Date(stepTime(i)).toISOString(),
      actualPct: null,
      projectedPct: turnoutPct(votes + (projectedVotes - votes) * progress, registered),
    });
  }
  const nowPoint = { at: new Date(nowMs).toISOString(), actualPct: base.currentTurnoutPct, projectedPct: base.currentTurnoutPct };

  return {
    ...base,
    state: 'en_curso',
    method,
    basedOnElections: method === 'historico' ? projections.length : 0,
    projectedVotes,
    projectedTurnoutPct: turnoutPct(projectedVotes, registered),
    interval: {
      lowVotes: bound(low),
      highVotes: bound(high),
      lowPct: turnoutPct(bound(low), registered),
      highPct: turnoutPct(bound(high), registered),
    },
    curve: [...actualCurve(nowMs), nowPoint, ...future],
  };
}

/* ============================================================
 * 2. MOMENTO DE DEFINICIÓN
 * ============================================================ */

// Cada punto de la evolución agrupa al menos 5 votos: con menos, ver qué
// opción sumó en un momento puntual permitiría deducir votos individuales
// (cruzándolo, por ejemplo, con la hora de ingreso de alguien).
const TIMELINE_MIN_VOTES_PER_POINT = 5;

// Tamaño de cada tramo de tiempo: la ventana dividida en ~24 partes, entre
// 5 y 60 minutos (una jornada de 12 h queda en tramos de 30 min).
function minutesPerStep(start, end) {
  const minutes = (toMs(end) - toMs(start)) / MINUTE_MS;
  return Math.min(60, Math.max(5, Math.round(minutes / 24)));
}

// Cómo evolucionó el primer lugar: cuántas veces cambió y desde cuándo el
// ganador (o el que va primero) lidera sin interrupciones.
// minuteCounts: [{ minute, optionId, votes }]
function leadTimeline({ options, minuteCounts, start, end }) {
  const total = sumVotes(minuteCounts);
  const stepMinutes = minutesPerStep(start, end);
  const granularity = { minutesPerStep: stepMinutes, minVotesPerPoint: TIMELINE_MIN_VOTES_PER_POINT };
  const optionList = options.map((o) => ({ optionId: o.optionId, label: o.label }));
  const empty = { granularity, options: optionList, checkpoints: [], changes: [] };

  if (total === 0) return { state: 'sin_votos', ...empty };
  if (total < TIMELINE_MIN_VOTES_PER_POINT) return { state: 'insuficiente', ...empty };

  const startMs = toMs(start);
  const stepMs = stepMinutes * MINUTE_MS;
  const byStep = new Map();
  for (const { minute, optionId, votes } of minuteCounts) {
    const step = Math.max(0, Math.floor((toMs(minute) - startMs) / stepMs));
    if (!byStep.has(step)) byStep.set(step, new Map());
    const counts = byStep.get(step);
    counts.set(optionId, (counts.get(optionId) || 0) + votes);
  }

  // Puntos de control: se acumulan tramos hasta juntar el mínimo de votos;
  // lo que sobre al final (menos del mínimo) se suma al último punto.
  const cumulative = new Map(optionList.map((o) => [o.optionId, 0]));
  const points = [];
  let pending = 0;
  let stepEnd = startMs;
  for (const step of [...byStep.keys()].sort((a, b) => a - b)) {
    for (const [optionId, votes] of byStep.get(step)) {
      cumulative.set(optionId, (cumulative.get(optionId) || 0) + votes);
      pending += votes;
    }
    stepEnd = startMs + (step + 1) * stepMs;
    if (pending >= TIMELINE_MIN_VOTES_PER_POINT) {
      points.push({ atMs: stepEnd, counts: new Map(cumulative) });
      pending = 0;
    }
  }
  if (pending > 0) points[points.length - 1] = { atMs: stepEnd, counts: new Map(cumulative) };

  const labelOf = new Map(optionList.map((o) => [o.optionId, o.label]));
  const checkpoints = points.map(({ atMs, counts }) => {
    const counted = [...counts.values()].reduce((sum, v) => sum + v, 0);
    const ranking = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const [first, second] = ranking;
    const tie = second && second[1] === first[1];
    return {
      at: new Date(Math.min(atMs, toMs(end))).toISOString(),
      votesCounted: counted,
      shares: ranking.map(([optionId, votes]) => ({ optionId, label: labelOf.get(optionId), pct: pct(votes, counted) })),
      leader: tie ? null : { optionId: first[0], label: labelOf.get(first[0]) },
      marginPp: second ? round1(pct(first[1], counted) - pct(second[1], counted)) : 100,
    };
  });

  // Un cambio es que pase a liderar una opción distinta de la última que
  // lideró; un empate intermedio no cuenta como cambio.
  const changes = [];
  let lastLeader = null;
  for (const point of checkpoints) {
    if (!point.leader) continue;
    if (lastLeader && point.leader.optionId !== lastLeader.optionId) {
      changes.push({ at: point.at, from: lastLeader.label, to: point.leader.label, votesCounted: point.votesCounted });
    }
    lastLeader = point.leader;
  }

  const currentLeader = checkpoints[checkpoints.length - 1].leader;
  let stableSince = null;
  if (currentLeader) {
    let i = checkpoints.length - 1;
    while (i > 0 && checkpoints[i - 1].leader?.optionId === currentLeader.optionId) i -= 1;
    stableSince = { at: checkpoints[i].at, votesCountedPct: pct(checkpoints[i].votesCounted, total), fromStart: i === 0 };
  }

  return {
    state: 'ok',
    ...empty,
    totalVotes: total,
    leadChanges: changes.length,
    changes,
    currentLeader,
    stableSince,
    checkpoints,
  };
}

/* ============================================================
 * 3. INTEGRIDAD DEL ACTA
 * ============================================================ */

// Recalcula toda la cadena de actas (mismo criterio que GET /verify de
// scrutiny-service, pero hecho por otro servicio): para cada acta, si su
// contenido coincide con su hash y si enlaza con la anterior.
function verifyLedgerChain(ledgerRows) {
  const byElection = new Map();
  const broken = [];
  let expectedPrevious = GENESIS_HASH;
  for (const row of ledgerRows) {
    const recomputed = computeRecordHash({
      previousHash: row.previous_hash,
      electionId: row.election_id,
      totalVotes: row.total_votes,
      results: row.results,
    });
    const status = { hashOk: recomputed === row.record_hash, linkOk: row.previous_hash === expectedPrevious };
    byElection.set(Number(row.election_id), status);
    if (!status.hashOk || !status.linkOk) broken.push(Number(row.election_id));
    expectedPrevious = row.record_hash;
  }
  return { valid: broken.length === 0, totalRecords: ledgerRows.length, brokenElectionIds: broken, byElection };
}

// Compara lo que el acta certificó con los votos que HOY están guardados.
// La cadena de hashes prueba que el acta no cambió; esto prueba que los
// votos tampoco (si se agregan o borran votos después de certificar, el
// acta sigue "íntegra" pero ya no representa lo que hay en la base).
// stored: { totalVotes, byOption: Map<optionId, votos>, byTable: Map<"puesto|mesa", votos> }
function compareWithStoredVotes(results, certifiedTotal, stored) {
  const certifiedByOption = new Map((results.overall || []).map((r) => [r.optionId, r]));
  const optionDiffs = [];
  for (const optionId of new Set([...certifiedByOption.keys(), ...stored.byOption.keys()])) {
    const certified = certifiedByOption.get(optionId)?.votes || 0;
    const current = stored.byOption.get(optionId) || 0;
    if (certified !== current) {
      optionDiffs.push({
        optionId,
        label: certifiedByOption.get(optionId)?.label || `Opción #${optionId}`,
        certified,
        stored: current,
      });
    }
  }

  const certifiedByTable = new Map((results.byTable || []).map((t) => [`${t.pollingPlace}|${t.votingTable}`, t.totalVotes]));
  const tableDiffs = [];
  for (const key of new Set([...certifiedByTable.keys(), ...stored.byTable.keys()])) {
    const certified = certifiedByTable.get(key) || 0;
    const current = stored.byTable.get(key) || 0;
    if (certified !== current) {
      const [pollingPlace, votingTable] = key.split('|');
      tableDiffs.push({ table: `${pollingPlace} · ${votingTable}`, certified, stored: current });
    }
  }

  return {
    certifiedTotal,
    storedTotal: stored.totalVotes,
    totalMatches: certifiedTotal === stored.totalVotes,
    optionDiffs,
    tableDiffs,
  };
}

// Informe completo para una elección: estado de su acta en la cadena, de la
// cadena en general y recuento contra los votos guardados, con la lista de
// problemas en palabras. "integra" solo si no aparece ninguno.
function buildIntegrityReport({ electionId, ledgerRows, stored }) {
  const index = ledgerRows.findIndex((r) => Number(r.election_id) === Number(electionId));
  if (index === -1) return { state: 'sin_certificar' };

  const record = ledgerRows[index];
  const chain = verifyLedgerChain(ledgerRows);
  const own = chain.byElection.get(Number(electionId));
  const votes = compareWithStoredVotes(record.results, record.total_votes, stored);

  const problems = [];
  if (!own.hashOk) problems.push('El contenido del acta no coincide con su hash: fue modificada después de certificarse.');
  if (!own.linkOk) problems.push('El acta no enlaza con la anterior: la cadena se rompe justo en esta acta.');
  const brokenBefore = ledgerRows
    .slice(0, index)
    .map((r) => Number(r.election_id))
    .filter((id) => chain.brokenElectionIds.includes(id));
  if (brokenBefore.length) {
    problems.push(`La cadena ya está rota antes de esta acta (elección #${brokenBefore[0]}), así que su historial no es confiable.`);
  }
  if (!votes.totalMatches) {
    const difference = votes.storedTotal - votes.certifiedTotal;
    problems.push(
      `Hay ${votes.storedTotal} votos guardados y el acta certificó ${votes.certifiedTotal}: ` +
        `${difference > 0 ? `aparecieron ${difference}` : `faltan ${-difference}`} después de certificar.`,
    );
  }
  if (votes.optionDiffs.length) problems.push(`${votes.optionDiffs.length} opción(es) no coinciden con el acta.`);
  if (votes.tableDiffs.length) problems.push(`${votes.tableDiffs.length} mesa(s) no coinciden con el acta.`);

  return {
    state: problems.length ? 'alterada' : 'integra',
    certifiedAt: record.certified_at,
    recordHash: record.record_hash,
    record: own,
    chain: { valid: chain.valid, totalRecords: chain.totalRecords, brokenElectionIds: chain.brokenElectionIds },
    votes,
    problems,
  };
}

/* ============================================================
 * 4. ACCESOS SOSPECHOSOS
 * ============================================================ */

const ACCESS_WINDOW_MINUTES = 15;
// Umbrales, todos dentro de una ventana de 15 minutos. Un votante que se
// equivoca de PIN una o dos veces es normal; estos buscan patrones que un
// humano distraído difícilmente produce.
const ACCESS_THRESHOLDS = {
  pinFailuresSameVoter: 5, // PIN incorrecto para la misma cédula (desde cualquier IP)
  unknownVotersSameIp: 5, // cédulas distintas que no están en el padrón, desde una IP
  failuresSameIp: 8, // fallos de cualquier tipo desde una IP (el tope del rate limit de login de votantes)
  adminFailuresSameUser: 3, // contraseña incorrecta para un mismo usuario admin
  pinFailuresBeforeSuccess: 3, // PIN incorrectos justo antes de un ingreso exitoso de esa cédula
};

const REASON_LABELS = {
  pin_incorrecto: 'PIN incorrecto',
  no_encontrado_o_inactivo: 'Cédula no encontrada o inactiva',
  sin_pin_asignado: 'Cédula sin PIN asignado',
  usuario_no_encontrado: 'Usuario admin inexistente',
  password_incorrecto: 'Contraseña admin incorrecta',
};

// El hash de la cédula es seudónimo, pero igual se muestra recortado: el
// auditor solo necesita distinguir un caso de otro y poder buscarlo.
const shortHash = (hash) => (hash ? `${String(hash).slice(0, 10)}…` : '(desconocida)');
// Express registra las IPv4 en formato IPv6 ("::ffff:10.0.0.5"); se
// muestran como IPv4, que es como las reconoce cualquiera.
const plainIp = (ip) => (ip ? String(ip).replace(/^::ffff:/, '') : ip);

// Mayor cantidad de eventos dentro de cualquier ventana de `windowMs`
// (ventana deslizante sobre eventos ya ordenados por tiempo). Con
// `distinctKey`, cuenta valores distintos en vez de eventos.
function peakInWindow(events, windowMs, distinctKey) {
  let best = { count: 0, from: null, to: null };
  const inWindow = new Map();
  let left = 0;
  for (let right = 0; right < events.length; right++) {
    const key = distinctKey ? distinctKey(events[right]) : right;
    inWindow.set(key, (inWindow.get(key) || 0) + 1);
    while (events[right].at - events[left].at > windowMs) {
      const leaving = distinctKey ? distinctKey(events[left]) : left;
      const remaining = inWindow.get(leaving) - 1;
      if (remaining) inWindow.set(leaving, remaining);
      else inWindow.delete(leaving);
      left += 1;
    }
    if (inWindow.size > best.count) best = { count: inWindow.size, from: events[left].at, to: events[right].at };
  }
  return best;
}

function groupBy(events, keyOf) {
  const groups = new Map();
  for (const event of events) {
    const key = keyOf(event);
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  return groups;
}

// events: [{ eventType, actorRef, ip, reason, at }] (logins de votantes y
// admins), en cualquier orden.
function detectSuspiciousAccess(events) {
  const windowMs = ACCESS_WINDOW_MINUTES * MINUTE_MS;
  const sorted = events.map((e) => ({ ...e, ip: plainIp(e.ip), at: toMs(e.at) })).sort((a, b) => a.at - b.at);
  const failures = sorted.filter((e) => e.eventType.startsWith('LOGIN_FAILURE_'));
  const voterFailures = failures.filter((e) => e.eventType === 'LOGIN_FAILURE_VOTER');
  const pinFailuresByVoter = groupBy(
    voterFailures.filter((e) => e.reason === 'pin_incorrecto'),
    (e) => e.actorRef,
  );
  const alerts = [];
  const addAlert = (alert, range) =>
    alerts.push({ ...alert, from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() });

  for (const [voter, group] of pinFailuresByVoter) {
    const peak = peakInWindow(group, windowMs);
    if (peak.count >= ACCESS_THRESHOLDS.pinFailuresSameVoter) {
      addAlert(
        {
          type: 'pin_repetido',
          severity: 'alta',
          title: 'Muchos PIN incorrectos para una misma cédula',
          subject: `Cédula ${shortHash(voter)}`,
          attempts: peak.count,
          detail: 'Alguien probó varios PIN para la misma cédula: puede ser un intento de adivinarlo.',
        },
        peak,
      );
    }
  }

  const unknownVoters = voterFailures.filter((e) => e.reason === 'no_encontrado_o_inactivo');
  for (const [ip, group] of groupBy(unknownVoters, (e) => e.ip)) {
    const peak = peakInWindow(group, windowMs, (e) => e.actorRef);
    if (peak.count >= ACCESS_THRESHOLDS.unknownVotersSameIp) {
      addAlert(
        {
          type: 'barrido_cedulas',
          severity: 'alta',
          title: 'Barrido de cédulas',
          subject: `IP ${ip}`,
          attempts: peak.count,
          detail: 'Desde la misma IP se probaron muchas cédulas que no están en el padrón.',
        },
        peak,
      );
    }
  }

  for (const [ip, group] of groupBy(failures, (e) => e.ip)) {
    const peak = peakInWindow(group, windowMs);
    if (peak.count >= ACCESS_THRESHOLDS.failuresSameIp) {
      addAlert(
        {
          type: 'ip_muchos_fallos',
          severity: 'media',
          title: 'IP con muchos intentos fallidos',
          subject: `IP ${ip}`,
          attempts: peak.count,
          detail:
            `Llegó al tope de intentos que permite el sistema (${ACCESS_THRESHOLDS.failuresSameIp} cada ` +
            `${ACCESS_WINDOW_MINUTES} min); los siguientes se bloquearon. En un puesto con una sola IP puede ser normal.`,
        },
        peak,
      );
    }
  }

  const adminFailures = failures.filter((e) => e.eventType === 'LOGIN_FAILURE_ADMIN');
  for (const [username, group] of groupBy(adminFailures, (e) => e.actorRef)) {
    const peak = peakInWindow(group, windowMs);
    if (peak.count >= ACCESS_THRESHOLDS.adminFailuresSameUser) {
      // Un usuario que no existe no es "contraseña equivocada": es alguien
      // probando nombres de usuario del panel.
      const unknownUser = group.every((e) => e.reason === 'usuario_no_encontrado');
      addAlert(
        {
          type: 'admin_fallos',
          severity: 'alta',
          title: unknownUser
            ? 'Intentos de ingreso con un usuario admin inexistente'
            : 'Intentos fallidos de ingreso como administrador',
          subject: `Usuario "${username}"`,
          attempts: peak.count,
          detail: unknownUser
            ? 'Ese usuario no existe en el panel: alguien puede estar adivinando nombres de usuario.'
            : 'Varias contraseñas incorrectas para un mismo usuario del panel.',
        },
        peak,
      );
    }
  }

  // El caso más serio: varios PIN fallidos y enseguida un ingreso exitoso
  // de esa misma cédula. Puede ser el votante equivocándose... o alguien
  // que terminó adivinando el PIN.
  const alreadyFlagged = new Set();
  for (const success of sorted.filter((e) => e.eventType === 'LOGIN_SUCCESS_VOTER')) {
    if (alreadyFlagged.has(success.actorRef)) continue;
    const before = (pinFailuresByVoter.get(success.actorRef) || []).filter(
      (f) => f.at < success.at && success.at - f.at <= windowMs,
    );
    if (before.length >= ACCESS_THRESHOLDS.pinFailuresBeforeSuccess) {
      alreadyFlagged.add(success.actorRef);
      addAlert(
        {
          type: 'exito_tras_fallos',
          severity: 'alta',
          title: 'Ingreso exitoso después de varios PIN incorrectos',
          subject: `Cédula ${shortHash(success.actorRef)}`,
          attempts: before.length,
          detail: 'Puede ser el votante equivocándose, o alguien que adivinó el PIN: conviene confirmarlo con el votante.',
        },
        { from: before[0].at, to: success.at },
      );
    }
  }

  alerts.sort((a, b) => (a.severity === b.severity ? b.attempts - a.attempts : a.severity === 'alta' ? -1 : 1));

  const byReason = new Map();
  for (const failure of failures) {
    const reason = REASON_LABELS[failure.reason] || failure.reason || 'Sin motivo registrado';
    byReason.set(reason, (byReason.get(reason) || 0) + 1);
  }

  return {
    windowMinutes: ACCESS_WINDOW_MINUTES,
    thresholds: ACCESS_THRESHOLDS,
    totals: {
      attempts: sorted.length,
      failures: failures.length,
      successes: sorted.length - failures.length,
      failureRatePct: pct(failures.length, sorted.length),
    },
    failuresByReason: [...byReason].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    topIps: [...groupBy(failures, (e) => e.ip)]
      .map(([ip, group]) => ({ ip, failures: group.length }))
      .sort((a, b) => b.failures - a.failures)
      .slice(0, 10),
    alerts,
  };
}

module.exports = {
  projectTurnout,
  leadTimeline,
  verifyLedgerChain,
  compareWithStoredVotes,
  buildIntegrityReport,
  detectSuspiciousAccess,
  ACCESS_THRESHOLDS,
};
