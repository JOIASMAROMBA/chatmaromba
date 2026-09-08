const { io } = require('socket.io-client');
const URL = process.env.CHAT_URL || 'http://localhost:' + (process.env.PORT || 3000);

function connect() {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'] });
    s.on('connect', () => resolve(s));
  });
}

function login(s, nick, avatar) {
  return new Promise((resolve) => s.emit('login', { nick, avatar }, resolve));
}

function checkNick(s, nick) {
  return new Promise((resolve) => s.emit('check-nick', { nick }, resolve));
}

async function client(nick) {
  const s = await connect();
  const res = await login(s, nick);
  return { s, res, me: res.me };
}

function join(s, roomId) {
  return new Promise((resolve) => s.emit('join', { roomId }, resolve));
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  const results = [];
  const check = (name, ok, extra) => {
    results.push((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
  };

  // ---------------------------------------------------------------- API
  const rooms = await fetch(URL + '/api/rooms').then((r) => r.json());
  check('GET /api/rooms', rooms.themes.length === 14 && rooms.states.length === 27,
    'temas=' + rooms.themes.length + ' estados=' + rooms.states.length);

  const html = await fetch(URL + '/').then((r) => r.text());
  check('index.html servido', html.includes('CHATMAROMBA'));

  const css = await fetch(URL + '/css/style.css');
  const js = await fetch(URL + '/js/app.js');
  const sio = await fetch(URL + '/socket.io/socket.io.js');
  check('estáticos (css/js/socket.io)', css.ok && js.ok && sio.ok);

  // ---------------------------------------------------------------- salas
  const a = await client('Monstro');
  const b = await client('Frango');
  check('login', a.me.nick === 'Monstro' && b.me.nick === 'Frango');

  const ja = await join(a.s, 'tema:venenos');
  const jb = await join(b.s, 'tema:venenos');
  check('join sala de tema', ja.ok && jb.ok && ja.room.name === 'Venenos', ja.room && ja.room.name);

  const bad = await join(a.s, 'tema:naoexiste');
  check('sala inválida rejeitada', bad.ok === false);
  await join(a.s, 'tema:venenos');

  const gotMessage = new Promise((resolve) => {
    b.s.on('message', (m) => { if (m.type === 'chat') resolve(m); });
  });
  a.s.emit('message', { text: 'bora treinar <script>alert(1)</script>' });
  const msg = await gotMessage;
  check('mensagem entregue em tempo real', msg.text.includes('bora treinar') && msg.nick === 'Monstro');

  const gotMembers = new Promise((resolve) => b.s.on('members', resolve));
  const c = await client('Veterano');
  await join(c.s, 'tema:venenos');
  const members = await gotMembers;
  check('lista de membros', members.members.length >= 2, 'n=' + members.members.length);

  const uf = await join(c.s, 'uf:SP');
  check('sala geral de estado', uf.ok && uf.room.name.includes('Geral'), uf.room && uf.room.name);
  const cidade = await join(c.s, 'cidade:SP:sao-jose-dos-campos');
  check('sala de cidade', cidade.ok && cidade.room.name === 'São José dos Campos / SP', cidade.room && cidade.room.name);

  const hist = await join(c.s, 'tema:venenos');
  check('histórico da sala', hist.history.some((m) => m.type === 'chat' && m.text.includes('bora treinar')),
    'msgs=' + hist.history.length);

  // ---------------------------------------------------------------- apelido exclusivo
  const intruso = await connect();

  const dup = await login(intruso, 'Monstro');
  check('apelido em uso é recusado', dup.ok === false && dup.error === 'nick-taken', dup.message);

  const dupCase = await login(intruso, 'MONSTRO');
  check('bloqueio ignora maiúscula', dupCase.ok === false && dupCase.error === 'nick-taken');

  const dupAccent = await login(intruso, 'Mónstro ');
  check('bloqueio ignora acento e espaço', dupAccent.ok === false && dupAccent.error === 'nick-taken');

  const short = await login(intruso, 'x');
  check('apelido curto recusado', short.ok === false && short.error === 'nick-invalid');

  const busy = await checkNick(intruso, 'Monstro');
  const freeNow = await checkNick(intruso, 'ApelidoQueNinguem');
  check('check-nick', busy.available === false && freeNow.available === true);

  const okLogin = await login(intruso, 'Monstro2');
  check('apelido livre é aceito', okLogin.ok === true && okLogin.me.nick === 'Monstro2');

  // trocar de apelido devolve o antigo para o pool
  await login(intruso, 'Monstro3');
  const reuseOld = await checkNick(a.s, 'Monstro2');
  check('trocar de nome libera o antigo', reuseOld.available === true);

  // manter o próprio apelido não conflita consigo mesmo
  const keepOwn = await login(intruso, 'Monstro3');
  check('reenviar o próprio apelido funciona', keepOwn.ok === true);

  // sair libera o apelido
  intruso.close();
  await wait(300);
  const afterLeave = await checkNick(a.s, 'Monstro3');
  check('apelido volta a ficar livre ao sair', afterLeave.available === true);

  const herdeiro = await client('Monstro3');
  check('outra pessoa assume o apelido liberado', herdeiro.res.ok === true && herdeiro.me.nick === 'Monstro3');
  herdeiro.s.close();

  // troca de nome dentro da sala vira aviso do sistema
  const renameNotice = new Promise((resolve) => {
    b.s.on('message', (m) => { if (m.type === 'system' && m.text.includes('agora é')) resolve(m); });
  });
  await login(a.s, 'MonstroPro');
  const notice = await Promise.race([renameNotice, wait(800)]);
  check('sala avisa a troca de apelido', Boolean(notice && notice.text), notice && notice.text);

  // ---------------------------------------------------------------- anti-flood
  let flooded = false;
  a.s.on('warning', () => { flooded = true; });
  for (let i = 0; i < 20; i += 1) a.s.emit('message', { text: 'spam ' + i });
  await wait(600);
  check('anti-flood', flooded);

  const stats = await fetch(URL + '/api/stats').then((r) => r.json());
  check('GET /api/stats', stats.online >= 3, JSON.stringify(stats.counts));

  [a, b, c].forEach((x) => x.s.close());
  console.log(results.join('\n'));
  const passed = results.filter((r) => r.startsWith('PASS')).length;
  console.log('\n' + passed + '/' + results.length + ' ok');
  process.exit(passed === results.length ? 0 : 1);
})();
