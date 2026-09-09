/**
 * Sonda de abuso do CHATMAROMBA.
 *
 * Tenta, contra um servidor de teste, as coisas que alguém mal-intencionado
 * tentaria. Cada verificação passa quando o servidor SE DEFENDE.
 *
 *   node test/attack.js        (precisa do servidor com MOD_PASSWORD definido)
 *
 * Nunca aponte para produção com carga alta: isso é um teste, não um alvo.
 */

const { io } = require('socket.io-client');

const URL = process.env.CHAT_URL || 'http://localhost:' + (process.env.PORT || 3555);
const MOD_PASS = process.env.MOD_PASSWORD || 'segredo';

let seq = 0;
function connect(opts = {}) {
  seq += 1;
  return new Promise((resolve, reject) => {
    const s = io(URL, {
      transports: ['websocket'],
      reconnection: false,
      auth: { token: 'sonda-' + seq + '-' + Date.now() },
      ...opts
    });
    const timer = setTimeout(() => reject(new Error('timeout')), 8000);
    s.on('connect', () => { clearTimeout(timer); resolve(s); });
    s.on('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function emit(s, event, payload) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    setTimeout(() => finish({ timeout: true }), 5000);
    s.emit(event, payload, finish);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, defended, extra) => {
  results.push((defended ? 'DEFENDIDO' : 'VULNERAVEL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
};

(async () => {
  const openSockets = [];
  const track = (s) => { openSockets.push(s); return s; };

  // ---------------------------------------------------------------- 1
  // Criar salas infinitas: "tema:geral~999999" não existe, mas o nome base
  // é válido. Se passar, dá para inflar a memória com salas fantasma.
  {
    const s = track(await connect());
    await emit(s, 'login', { nick: 'SondaSalas' });
    const res = await emit(s, 'join', { roomId: 'tema:geral~999999' });
    const entrouEmSalaFantasma = res && res.ok && res.room && res.room.shard > 40;
    check('divisão de sala fora do limite', !entrouEmSalaFantasma,
      res && res.room ? 'entrou em: ' + res.room.id : String(res && res.error));
  }

  // ---------------------------------------------------------------- 2
  // Força bruta na senha do moderador.
  {
    const s = track(await connect());
    await emit(s, 'login', { nick: 'SondaSenha' });
    let tentativas = 0;
    let bloqueado = false;
    for (let i = 0; i < 40; i += 1) {
      const res = await emit(s, 'mod-login', { password: 'chute-' + i });
      tentativas += 1;
      if (res && res.error === 'rate-limit') { bloqueado = true; break; }
    }
    check('força bruta na senha do moderador', bloqueado,
      bloqueado ? 'travou na tentativa ' + tentativas : tentativas + ' tentativas livres');
  }

  // ---------------------------------------------------------------- 3
  // Mensagem gigante: o padrão do socket.io aceita 1 MB por evento.
  {
    const s = track(await connect());
    await emit(s, 'login', { nick: 'SondaGigante' });
    await emit(s, 'join', { roomId: 'tema:zoeira' });
    const gigante = 'A'.repeat(900 * 1024);
    let derrubado = false;
    s.on('disconnect', () => { derrubado = true; });
    const res = await emit(s, 'message', { text: gigante });
    await wait(400);
    check('mensagem de 900 KB', derrubado || (res && res.ok === false),
      derrubado ? 'conexão cortada' : 'servidor aceitou o evento');
  }

  // ---------------------------------------------------------------- 4
  // Enxurrada de "está digitando": cada um vira broadcast para a sala toda.
  {
    const s = track(await connect());
    await emit(s, 'login', { nick: 'SondaDigitando' });
    await emit(s, 'join', { roomId: 'tema:zoeira' });

    const espiao = track(await connect());
    await emit(espiao, 'login', { nick: 'SondaEspiao' });
    await emit(espiao, 'join', { roomId: 'tema:zoeira' });

    let recebidos = 0;
    espiao.on('typing', () => { recebidos += 1; });
    for (let i = 0; i < 600; i += 1) s.emit('typing', { typing: i % 2 === 0 });
    await wait(1200);
    check('enxurrada de "digitando"', recebidos < 100, recebidos + ' de 600 repassados');
  }

  // ---------------------------------------------------------------- 5
  // Troca de sala em looping: cada entrada gera avisos e listas.
  {
    const s = track(await connect());
    await emit(s, 'login', { nick: 'SondaPulo' });
    let recusas = 0;
    for (let i = 0; i < 80; i += 1) {
      const res = await emit(s, 'join', { roomId: i % 2 ? 'tema:treta' : 'tema:zoeira' });
      if (res && res.ok === false) recusas += 1;
    }
    check('troca de sala em looping', recusas > 0, recusas + ' de 80 recusadas');
  }

  // ---------------------------------------------------------------- 6
  // Sequestro de apelidos: abrir muitas conexões e reservar todos os nomes.
  {
    const ALVO = 60;
    const nicks = [];
    let recusado = false;

    for (let i = 0; i < ALVO; i += 1) {
      try {
        const s = track(await connect());
        // o servidor pode aceitar o socket e recusar logo em seguida
        s.on('overloaded', () => { recusado = true; });
        const res = await emit(s, 'login', { nick: 'Sequestro' + i });
        if (res && res.ok) nicks.push(res.me.nick);
        else recusado = true;
        if (recusado) break;
      } catch (e) {
        recusado = true;
        break;
      }
    }
    check('sequestro de apelidos em massa', recusado && nicks.length < ALVO,
      recusado
        ? 'barrado após ' + nicks.length + ' apelidos'
        : nicks.length + ' apelidos reservados por um só cliente');
  }

  // ---------------------------------------------------------------- 6b
  // Trocar de identidade mentindo o X-Forwarded-For. Se colar, o atacante
  // ganha um limite novinho a cada requisição e escapa de qualquer banimento.
  {
    let escapou = false;
    for (let i = 0; i < 400; i += 1) {
      const res = await fetch(URL + '/api/stats', {
        headers: { 'X-Forwarded-For': '203.0.113.' + (i % 250) }
      });
      if (res.status === 429) break;            // o freio reconheceu o mesmo cliente
      if (i === 399) escapou = true;            // 400 requisições sem freio: mentira funcionou
    }
    check('trocar de IP mentindo o cabeçalho', !escapou,
      escapou ? 'furou o limite com IP falso' : 'o freio ignorou o IP inventado');
  }

  // ---------------------------------------------------------------- 7
  // Cabeçalhos de segurança na resposta HTTP.
  {
    const res = await fetch(URL + '/');
    const csp = res.headers.get('content-security-policy');
    const powered = res.headers.get('x-powered-by');
    check('Content-Security-Policy presente', Boolean(csp), csp ? 'ok' : 'ausente');
    check('X-Powered-By escondido', !powered, powered ? 'vaza: ' + powered : 'ok');
  }

  // ---------------------------------------------------------------- 8
  // Enxurrada de requisições HTTP na API.
  {
    let bloqueios = 0;
    for (let i = 0; i < 250; i += 1) {
      const res = await fetch(URL + '/api/rooms');
      if (res.status === 429) { bloqueios += 1; break; }
    }
    check('enxurrada de requisições HTTP', bloqueios > 0,
      bloqueios ? 'respondeu 429' : '250 requisições sem freio');
  }

  openSockets.forEach((s) => { try { s.close(); } catch (e) { /* ignore */ } });

  console.log('\n' + results.join('\n'));
  const defendidos = results.filter((r) => r.startsWith('DEFENDIDO')).length;
  console.log('\n' + defendidos + '/' + results.length + ' defendidos');
  process.exit(defendidos === results.length ? 0 : 1);
})().catch((err) => {
  console.error('sonda falhou:', err.message);
  process.exit(2);
});
