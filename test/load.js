/**
 * Teste de carga do CHATMAROMBA.
 *
 *   node test/load.js [clientes] [msgs por segundo no total] [segundos]
 *   node test/load.js 1000 50 20
 *
 * Conecta N clientes na mesma sala, dispara mensagens no ritmo pedido e mede
 * a latência de entrega (tempo entre enviar e o outro lado receber).
 */

const { io } = require('socket.io-client');

const URL = process.env.CHAT_URL || 'http://localhost:' + (process.env.PORT || 3000);
const CLIENTS = Number(process.argv[2] || 500);
const MSGS_PER_SEC = Number(process.argv[3] || 20);
const DURATION_S = Number(process.argv[4] || 15);
const ROOM = process.env.ROOM || 'tema:geral';
let TERMS = '';

const sockets = [];
const roomSizes = {};
let expectedDeliveries = 0;
const latencies = [];
let received = 0;
let sent = 0;
let errors = 0;

function pct(list, p) {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function connectOne(index) {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'], reconnection: false });
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };

    s.on('connect_error', () => { errors += 1; finish(false); });
    s.on('connect', () => {
      s.emit('login', { nick: 'Carga' + index, terms: TERMS }, (res) => {
        if (!res || !res.ok) { errors += 1; return finish(false); }
        s.emit('join', { roomId: ROOM }, (res) => {
          // sem isso, um join recusado passaria despercebido e o teste
          // mediria "100% de perda" em vez de apontar a causa
          if (!res || !res.ok) { errors += 1; return finish(false); }
          s.__room = res.room ? res.room.id : ROOM;
          roomSizes[s.__room] = (roomSizes[s.__room] || 0) + 1;
          sockets.push(s);
          // mede a latência: o texto carrega o instante do envio
          s.on('messages', (list) => { for (const m of list) {
            if (m.type !== 'chat') continue;
            received += 1;
            const at = Number(String(m.text).split('|')[1]);
            if (at) latencies.push(Date.now() - at);
          } });
          finish(true);
        });
      });
    });
  });
}

(async () => {
  // sem o aceite das regras o servidor recusa a entrada nas salas
  TERMS = await fetch(URL + '/api/terms').then((r) => r.json()).then((t) => t.versao).catch(() => '');
  if (!TERMS) throw new Error('não consegui ler a versão das regras em ' + URL);

  console.log(`\nAlvo: ${URL}  ·  sala: ${ROOM}`);
  console.log(`Abrindo ${CLIENTS} conexões...`);

  const startConnect = Date.now();
  // conecta em lotes para não estourar o handshake de uma vez
  for (let i = 0; i < CLIENTS; i += 50) {
    await Promise.all(
      Array.from({ length: Math.min(50, CLIENTS - i) }, (_, k) => connectOne(i + k))
    );
    process.stdout.write('\r  conectados: ' + sockets.length + '/' + CLIENTS);
  }
  const connectMs = Date.now() - startConnect;
  console.log(`\n  ${sockets.length} conectados em ${(connectMs / 1000).toFixed(1)}s` +
    (errors ? `  (${errors} falharam)` : ''));

  const before = await fetch(URL + '/health').then((r) => r.json()).catch(() => null);

  console.log(`\nDisparando ~${MSGS_PER_SEC} msg/s por ${DURATION_S}s ` +
    `(cada uma vai para ${sockets.length} pessoas = ~${MSGS_PER_SEC * sockets.length} entregas/s)...`);

  // o timer do Windows não desce de ~15ms, então mandamos em rajadas de 20 em 20ms
  const TICK_MS = 20;
  const perTick = Math.max(1, Math.round((MSGS_PER_SEC * TICK_MS) / 1000));
  const startSend = Date.now();
  const timer = setInterval(() => {
    for (let i = 0; i < perTick; i += 1) {
      const s = sockets[Math.floor(Math.random() * sockets.length)];
      if (!s) return;
      sent += 1;
      expectedDeliveries += roomSizes[s.__room] || 1;
      s.emit('message', { text: 'carga|' + Date.now() });
    }
  }, TICK_MS);

  await new Promise((r) => setTimeout(r, DURATION_S * 1000));
  clearInterval(timer);
  await new Promise((r) => setTimeout(r, 2000));   // deixa a fila drenar

  const elapsed = (Date.now() - startSend) / 1000;
  const after = await fetch(URL + '/health').then((r) => r.json()).catch(() => null);

  console.log('\n──────── resultado ────────');
  console.log(`conexões vivas .......... ${sockets.length}`);
  console.log(`mensagens enviadas ...... ${sent}  (${(sent / elapsed).toFixed(1)}/s)`);
  console.log(`entregas recebidas ...... ${received}  (${(received / elapsed).toFixed(0)}/s)`);
  console.log(`entregas esperadas ...... ~${expectedDeliveries}`);
  console.log(`perda ................... ${(100 - (received / expectedDeliveries) * 100).toFixed(1)}%`);
  console.log(`salas usadas ............ ${Object.keys(roomSizes).length} (teto de ${process.env.ROOM_CAPACITY || 250} por sala)`);
  console.log(`latência p50 ............ ${pct(latencies, 50)} ms`);
  console.log(`latência p95 ............ ${pct(latencies, 95)} ms`);
  console.log(`latência p99 ............ ${pct(latencies, 99)} ms`);
  console.log(`pior caso ............... ${latencies.reduce((a, b) => (b > a ? b : a), 0)} ms`);
  if (before && after && after.memory) {
    console.log(`memória do servidor ..... ${mb(before.memory.rss)} → ${mb(after.memory.rss)}`);
  }
  console.log('───────────────────────────\n');

  sockets.forEach((s) => s.close());
  process.exit(0);
})();
