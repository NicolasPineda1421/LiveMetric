// Pruebas unitarias de la estadística avanzada (advancedStats.js): funciones
// puras, sin base de datos. Los casos se arman a mano para que cada regla
// (proyección, cambios de líder, cadena de actas, accesos sospechosos) se
// pueda verificar con números calculables de cabeza.
const {
  projectTurnout,
  leadTimeline,
  buildIntegrityReport,
  detectSuspiciousAccess,
} = require('../advancedStats');
const { GENESIS_HASH, computeRecordHash } = require('../hashChain');

const START = new Date('2026-03-01T08:00:00Z');
const at = (minutes) => new Date(START.getTime() + minutes * 60 * 1000);

describe('projectTurnout', () => {
  const END = at(600); // ventana de 10 horas

  it('no proyecta una elección que todavía no empezó', () => {
    const r = projectTurnout({ status: 'scheduled', start: START, end: END, now: at(-10), registered: 100, minuteCounts: [] });
    expect(r.state).toBe('sin_iniciar');
  });

  it('dice "insuficiente" antes del 10% de la jornada, aunque ya haya votos', () => {
    const r = projectTurnout({
      status: 'active', start: START, end: END, now: at(30), registered: 1000,
      minuteCounts: [{ minute: at(10), votes: 40 }],
    });
    expect(r.state).toBe('insuficiente');
  });

  it('sin historial proyecta con el ritmo actual: 100 votos a mitad de jornada → 200 al cierre', () => {
    const r = projectTurnout({
      status: 'active', start: START, end: END, now: at(300), registered: 1000,
      minuteCounts: [{ minute: at(60), votes: 50 }, { minute: at(200), votes: 50 }],
    });
    expect(r.state).toBe('en_curso');
    expect(r.method).toBe('ritmo_constante');
    expect(r.projectedVotes).toBe(200);
    expect(r.projectedTurnoutPct).toBe(20);
    // Intervalo de Poisson para los 100 votos que faltan: ±1.96·√100 ≈ ±20.
    expect(r.interval.lowVotes).toBe(180);
    expect(r.interval.highVotes).toBe(220);
  });

  it('con historial usa la mediana de las elecciones anteriores y su rango', () => {
    // A mitad de su ventana, una llevaba el 25% de sus votos y la otra el
    // 50%: con 100 votos ahora, proyectan 400 y 200 → mediana 300.
    const history = [
      { start: START, end: END, minuteCounts: [{ minute: at(60), votes: 25 }, { minute: at(480), votes: 75 }] },
      { start: START, end: END, minuteCounts: [{ minute: at(120), votes: 50 }, { minute: at(540), votes: 50 }] },
    ];
    const r = projectTurnout({
      status: 'active', start: START, end: END, now: at(300), registered: 1000,
      minuteCounts: [{ minute: at(100), votes: 100 }], history,
    });
    expect(r.method).toBe('historico');
    expect(r.basedOnElections).toBe(2);
    expect(r.projectedVotes).toBe(300);
    expect(r.interval.lowVotes).toBe(200);
    expect(r.interval.highVotes).toBe(400);
  });

  it('nunca proyecta más votos que votantes habilitados', () => {
    const r = projectTurnout({
      status: 'active', start: START, end: END, now: at(300), registered: 150,
      minuteCounts: [{ minute: at(100), votes: 100 }],
    });
    expect(r.projectedVotes).toBeLessThanOrEqual(150);
    expect(r.interval.highVotes).toBeLessThanOrEqual(150);
  });

  it('con más votos que votantes activos (dato inconsistente) no proyecta menos de lo ya votado, y el % queda en 100', () => {
    const r = projectTurnout({
      status: 'active', start: START, end: END, now: at(300), registered: 13,
      minuteCounts: [{ minute: at(100), votes: 15 }],
    });
    expect(r.projectedVotes).toBe(15);
    expect(r.projectedTurnoutPct).toBe(100);
    expect(r.currentTurnoutPct).toBe(100);
  });

  it('cerrada: la participación final es la real, sin proyección', () => {
    const r = projectTurnout({
      status: 'closed', start: START, end: END, now: at(700), registered: 200,
      minuteCounts: [{ minute: at(100), votes: 50 }],
    });
    expect(r.state).toBe('final');
    expect(r.projectedTurnoutPct).toBe(25);
    expect(r.interval).toBeNull();
  });

  it('la curva muestra lo real hasta ahora y la proyección desde ahora hasta el cierre', () => {
    const r = projectTurnout({
      status: 'active', start: START, end: END, now: at(300), registered: 1000,
      minuteCounts: [{ minute: at(60), votes: 100 }],
    });
    const last = r.curve[r.curve.length - 1];
    expect(last.at).toBe(END.toISOString());
    expect(last.projectedPct).toBe(r.projectedTurnoutPct);
    expect(r.curve.filter((p) => p.actualPct !== null).every((p) => new Date(p.at) <= at(300))).toBe(true);
  });
});

describe('leadTimeline', () => {
  const END = at(120); // 2 horas → tramos de 5 minutos
  const options = [{ optionId: 1, label: 'A' }, { optionId: 2, label: 'B' }];

  it('sin votos no hay nada que mostrar', () => {
    expect(leadTimeline({ options, minuteCounts: [], start: START, end: END }).state).toBe('sin_votos');
  });

  it('con menos de 5 votos no muestra la evolución (revelaría votos individuales)', () => {
    const r = leadTimeline({ options, minuteCounts: [{ minute: at(1), optionId: 1, votes: 3 }], start: START, end: END });
    expect(r.state).toBe('insuficiente');
    expect(r.checkpoints).toHaveLength(0);
  });

  it('cuenta los cambios de primer lugar y desde cuándo lidera el actual', () => {
    const r = leadTimeline({
      options,
      minuteCounts: [
        { minute: at(2), optionId: 1, votes: 6 }, // A 6 - B 0 → lidera A
        { minute: at(22), optionId: 2, votes: 10 }, // A 6 - B 10 → pasa B
        { minute: at(42), optionId: 1, votes: 10 }, // A 16 - B 10 → vuelve A
      ],
      start: START,
      end: END,
    });
    expect(r.state).toBe('ok');
    expect(r.leadChanges).toBe(2);
    expect(r.changes.map((c) => `${c.from}→${c.to}`)).toEqual(['A→B', 'B→A']);
    expect(r.currentLeader.label).toBe('A');
    expect(r.stableSince.fromStart).toBe(false);
    expect(r.stableSince.votesCountedPct).toBe(100);
  });

  it('si lidera desde el principio no hay cambios', () => {
    const r = leadTimeline({
      options,
      minuteCounts: [{ minute: at(2), optionId: 1, votes: 8 }, { minute: at(30), optionId: 2, votes: 5 }],
      start: START,
      end: END,
    });
    expect(r.leadChanges).toBe(0);
    expect(r.stableSince.fromStart).toBe(true);
  });

  it('cada punto de la evolución suma al menos 5 votos nuevos', () => {
    const minuteCounts = Array.from({ length: 23 }, (_, i) => ({ minute: at(i * 3), optionId: (i % 2) + 1, votes: 1 }));
    const r = leadTimeline({ options, minuteCounts, start: START, end: END });
    let previous = 0;
    for (const point of r.checkpoints) {
      expect(point.votesCounted - previous).toBeGreaterThanOrEqual(5);
      previous = point.votesCounted;
    }
    expect(previous).toBe(23);
  });

  it('un empate al final deja sin líder actual', () => {
    const r = leadTimeline({
      options,
      minuteCounts: [{ minute: at(2), optionId: 1, votes: 5 }, { minute: at(30), optionId: 2, votes: 5 }],
      start: START,
      end: END,
    });
    expect(r.currentLeader).toBeNull();
    expect(r.stableSince).toBeNull();
  });
});

describe('buildIntegrityReport', () => {
  // Arma un libro de 2 actas encadenadas correctamente, como lo haría
  // scrutiny-service al certificar.
  function ledger() {
    const results1 = {
      overall: [{ optionId: 1, label: 'A', votes: 3 }, { optionId: 2, label: 'B', votes: 2 }],
      byTable: [{ pollingPlace: 'Central', votingTable: 'Mesa 1', totalVotes: 5 }],
      winner: { optionId: 1, label: 'A', votes: 3, tie: false },
    };
    const results2 = {
      overall: [{ optionId: 3, label: 'C', votes: 4 }],
      byTable: [{ pollingPlace: 'Norte', votingTable: 'Mesa 1', totalVotes: 4 }],
      winner: { optionId: 3, label: 'C', votes: 4, tie: false },
    };
    const hash1 = computeRecordHash({ previousHash: GENESIS_HASH, electionId: 10, totalVotes: 5, results: results1 });
    const hash2 = computeRecordHash({ previousHash: hash1, electionId: 11, totalVotes: 4, results: results2 });
    return [
      { election_id: 10, total_votes: 5, results: results1, previous_hash: GENESIS_HASH, record_hash: hash1 },
      { election_id: 11, total_votes: 4, results: results2, previous_hash: hash1, record_hash: hash2 },
    ];
  }
  const storedFor10 = () => ({
    totalVotes: 5,
    byOption: new Map([[1, 3], [2, 2]]),
    byTable: new Map([['Central|Mesa 1', 5]]),
  });

  it('una elección sin acta queda "sin_certificar"', () => {
    expect(buildIntegrityReport({ electionId: 99, ledgerRows: ledger(), stored: storedFor10() }).state).toBe('sin_certificar');
  });

  it('acta intacta y votos iguales a los certificados → "integra"', () => {
    const r = buildIntegrityReport({ electionId: 10, ledgerRows: ledger(), stored: storedFor10() });
    expect(r.state).toBe('integra');
    expect(r.problems).toEqual([]);
    expect(r.chain).toEqual({ valid: true, totalRecords: 2, brokenElectionIds: [] });
  });

  it('detecta un acta modificada en la base después de certificarse', () => {
    const rows = ledger();
    rows[0].results.overall[0].votes = 30; // se cambia el resultado sin recalcular el hash
    const r = buildIntegrityReport({ electionId: 10, ledgerRows: rows, stored: storedFor10() });
    expect(r.state).toBe('alterada');
    expect(r.record.hashOk).toBe(false);
  });

  it('un acta rota invalida el historial de las que vienen después', () => {
    const rows = ledger();
    rows[0].results.overall[0].votes = 30;
    const r = buildIntegrityReport({
      electionId: 11,
      ledgerRows: rows,
      stored: { totalVotes: 4, byOption: new Map([[3, 4]]), byTable: new Map([['Norte|Mesa 1', 4]]) },
    });
    expect(r.state).toBe('alterada');
    expect(r.record.hashOk).toBe(true);
    expect(r.problems.join(' ')).toMatch(/rota antes de esta acta \(elección #10\)/);
  });

  it('detecta votos agregados después de certificar, aunque el acta siga intacta', () => {
    const stored = storedFor10();
    stored.totalVotes = 6;
    stored.byOption.set(2, 3);
    stored.byTable.set('Central|Mesa 1', 6);
    const r = buildIntegrityReport({ electionId: 10, ledgerRows: ledger(), stored });
    expect(r.state).toBe('alterada');
    expect(r.record).toEqual({ hashOk: true, linkOk: true });
    expect(r.votes.optionDiffs).toEqual([{ optionId: 2, label: 'B', certified: 2, stored: 3 }]);
    expect(r.problems.join(' ')).toMatch(/aparecieron 1 después de certificar/);
  });

  it('el hashChain de analytics coincide con el de scrutiny-service (la verificación es independiente pero con el mismo algoritmo)', () => {
    const scrutiny = require('../../../scrutiny/src/hashChain');
    const sample = { previousHash: GENESIS_HASH, electionId: 7, totalVotes: 2, results: { b: [1, { z: 2, a: 1 }], a: 'x' } };
    expect(computeRecordHash(sample)).toBe(scrutiny.computeRecordHash(sample));
  });
});

describe('detectSuspiciousAccess', () => {
  const voterFailure = (minute, actorRef, reason, ip = '10.0.0.1') => ({
    eventType: 'LOGIN_FAILURE_VOTER', actorRef, ip, reason, at: at(minute),
  });
  const types = (r) => r.alerts.map((a) => a.type);

  it('5 PIN incorrectos para la misma cédula en 15 minutos → alerta', () => {
    const events = [0, 2, 4, 6, 8].map((m) => voterFailure(m, 'hashA', 'pin_incorrecto'));
    expect(types(detectSuspiciousAccess(events))).toContain('pin_repetido');
  });

  it('4 PIN incorrectos (un votante que se equivoca) no alertan', () => {
    const events = [0, 2, 4, 6].map((m) => voterFailure(m, 'hashA', 'pin_incorrecto'));
    expect(detectSuspiciousAccess(events).alerts).toEqual([]);
  });

  it('5 cédulas inexistentes desde una IP en 15 minutos → barrido; espaciadas en una hora, no', () => {
    const quick = ['h1', 'h2', 'h3', 'h4', 'h5'].map((h, i) => voterFailure(i, h, 'no_encontrado_o_inactivo'));
    expect(types(detectSuspiciousAccess(quick))).toContain('barrido_cedulas');
    const spread = ['h1', 'h2', 'h3', 'h4', 'h5'].map((h, i) => voterFailure(i * 15, h, 'no_encontrado_o_inactivo'));
    expect(types(detectSuspiciousAccess(spread))).not.toContain('barrido_cedulas');
  });

  it('8 fallos desde una IP → alerta de severidad media (puede ser un puesto compartido)', () => {
    const events = Array.from({ length: 8 }, (_, i) => voterFailure(i, `h${i % 3}`, 'sin_pin_asignado'));
    const alert = detectSuspiciousAccess(events).alerts.find((a) => a.type === 'ip_muchos_fallos');
    expect(alert.severity).toBe('media');
    expect(alert.attempts).toBe(8);
  });

  it('un usuario admin inexistente se explica como adivinanza de usuarios, no como contraseña equivocada', () => {
    const events = [0, 1, 2].map((m) => ({
      eventType: 'LOGIN_FAILURE_ADMIN', actorRef: 'root', ip: '10.0.0.9', reason: 'usuario_no_encontrado', at: at(m),
    }));
    expect(detectSuspiciousAccess(events).alerts[0].title).toBe('Intentos de ingreso con un usuario admin inexistente');
  });

  it('las IPv4 guardadas en formato IPv6 (::ffff:) se muestran como IPv4', () => {
    const events = Array.from({ length: 8 }, (_, i) => voterFailure(i, `h${i}`, 'sin_pin_asignado', '::ffff:192.168.1.20'));
    const r = detectSuspiciousAccess(events);
    expect(r.alerts[0].subject).toBe('IP 192.168.1.20');
    expect(r.topIps[0].ip).toBe('192.168.1.20');
  });

  it('3 contraseñas incorrectas para un mismo admin → alerta', () => {
    const events = [0, 1, 2].map((m) => ({
      eventType: 'LOGIN_FAILURE_ADMIN', actorRef: 'admin', ip: '10.0.0.9', reason: 'password_incorrecto', at: at(m),
    }));
    expect(types(detectSuspiciousAccess(events))).toContain('admin_fallos');
  });

  it('varios PIN incorrectos y enseguida un ingreso exitoso de esa cédula → la alerta más seria', () => {
    const events = [
      ...[0, 1, 2].map((m) => voterFailure(m, 'hashB', 'pin_incorrecto')),
      { eventType: 'LOGIN_SUCCESS_VOTER', actorRef: 'hashB', ip: '10.0.0.1', reason: null, at: at(3) },
    ];
    const r = detectSuspiciousAccess(events);
    expect(r.alerts[0].type).toBe('exito_tras_fallos');
    expect(r.alerts[0].severity).toBe('alta');
    expect(r.alerts[0].subject).toBe('Cédula hashB…');
  });

  it('las alertas altas van antes que las medias, y los totales cuadran', () => {
    const events = [
      ...Array.from({ length: 8 }, (_, i) => voterFailure(i, `h${i}`, 'sin_pin_asignado', '10.0.0.2')),
      ...[0, 1, 2].map((m) => ({ eventType: 'LOGIN_FAILURE_ADMIN', actorRef: 'root', ip: '10.0.0.9', reason: 'usuario_no_encontrado', at: at(m) })),
      { eventType: 'LOGIN_SUCCESS_VOTER', actorRef: 'hZ', ip: '10.0.0.3', reason: null, at: at(5) },
    ];
    const r = detectSuspiciousAccess(events);
    expect(r.alerts.map((a) => a.severity)).toEqual(['alta', 'media']);
    expect(r.totals).toEqual({ attempts: 12, failures: 11, successes: 1, failureRatePct: 91.7 });
    expect(r.topIps[0]).toEqual({ ip: '10.0.0.2', failures: 8 });
  });
});
