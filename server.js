/**
 * CHATMAROMBA — servidor de bate-papo em tempo real.
 * Express (estáticos + API) + Socket.IO (mensagens).
 * Estado em memória: nada é persistido em disco.
 */

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { THEMES, STATES, buildRooms } = require('./shared/rooms');
const mod = require('./shared/moderation');

const PORT = process.env.PORT || 3000;
const HISTORY_SIZE = 80;          // mensagens guardadas por sala
const MAX_MESSAGE_LEN = 500;
const MAX_NICK_LEN = 18;
const MIN_NICK_LEN = 2;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MSGS = 12;         // mensagens por janela
const MEMBER_LIST_LIMIT = 80;     // nomes enviados na lista "quem está aqui"
const BUSY_ROOM_SIZE = 40;        // acima disso, some o aviso de entrou/saiu
const COUNTS_INTERVAL_MS = 1500;  // ritmo do broadcast de ocupação das salas

/**
 * Teto de gente por sala. Cada mensagem numa sala é enviada uma vez por pessoa
 * presente, então sala grande custa banda ao quadrado. Ao encher, o servidor
 * abre "Sala 2", "Sala 3"... e o papo continua legível e barato.
 */
const ROOM_CAPACITY = Number(process.env.ROOM_CAPACITY || 250);
const MAX_SHARDS = 40;
const SHARD_SEP = '~';

/** Acima disso, as mensagens saem em lote em vez de uma a uma */
const BATCH_ABOVE = 60;
const BATCH_MS = 80;

/** Senha do moderador. Sem ela, a moderação fica desligada. */
const MOD_PASSWORD = process.env.MOD_PASSWORD || '';

const ROOMS = buildRooms();

/** roomId -> array de mensagens (ring buffer simples) */
const history = new Map();
/** socket.id -> { nick, nickKey, avatar, color, roomId, sentAt: number[] } */
const users = new Map();
/**
 * Apelidos ocupados no momento: chave normalizada -> socket.id do dono.
 * A reserva vale só enquanto a pessoa está conectada; ao sair, o apelido é liberado.
 */
const nicksInUse = new Map();

/**
 * Em produção, defina ALLOWED_ORIGIN com o seu domínio (ex.: https://chatmaromba.com)
 * para que só o seu site possa abrir sockets. Vários domínios: separe por vírgula.
 */
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN
  ? process.env.ALLOWED_ORIGIN.split(',').map((o) => o.trim())
  : '*';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ALLOWED_ORIGIN } });

app.set('trust proxy', 1);   // atrás do proxy do host (Render, Railway, Fly...)

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.get('/api/rooms', (_req, res) => {
  res.json({ themes: THEMES, states: STATES });
});

app.get('/api/stats', (_req, res) => {
  res.json({ online: users.size, counts: roomCounts() });
});

app.get('/health', (_req, res) => res.json({
  ok: true,
  uptime: process.uptime(),
  sockets: users.size,
  memory: process.memoryUsage()
}));

// ---------------------------------------------------------------- helpers

const AVATARS = ['💪', '🦍', '🐺', '🔥', '⚡', '🥇', '🍗', '🥤', '🧊', '🦈', '👑', '🐉', '🚀', '🥊', '🏋️', '😎'];
const NICK_COLORS = ['#7c5cff', '#00d4ff', '#ff4d94', '#22c55e', '#facc15', '#f97316', '#c026d3', '#38bdf8', '#4ade80', '#ff5f6d'];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function cleanText(value, maxLen) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function sanitizeNick(value) {
  return cleanText(value, MAX_NICK_LEN).replace(/[<>]/g, '');
}

/**
 * Chave de comparação de apelidos: sem acento, sem caixa e sem espaço.
 * "Monstro do Supino", "monstrodosupino" e "MONSTRO DO SUPINO" são o mesmo nome.
 */
function nickKey(nick) {
  return String(nick)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, '');
}

/** true se o apelido já pertence a outra pessoa conectada */
function isNickTaken(nick, socketId) {
  const owner = nicksInUse.get(nickKey(nick));
  return Boolean(owner) && owner !== socketId;
}

/** Reserva o apelido para este socket, soltando o anterior */
function claimNick(user, socketId, nick) {
  releaseNick(user, socketId);
  user.nick = nick;
  user.nickKey = nickKey(nick);
  nicksInUse.set(user.nickKey, socketId);
}

/** Devolve o apelido ao pool — chamado ao trocar de nome e ao desconectar */
function releaseNick(user, socketId) {
  if (!user.nickKey) return;
  if (nicksInUse.get(user.nickKey) === socketId) nicksInUse.delete(user.nickKey);
  user.nickKey = null;
}

// ------------------------------------------------- divisão de sala cheia

/** "tema:geral~3" -> "tema:geral" */
function baseRoomId(roomId) {
  const at = roomId.indexOf(SHARD_SEP);
  return at === -1 ? roomId : roomId.slice(0, at);
}

/** "tema:geral~3" -> 3 */
function shardNumber(roomId) {
  const at = roomId.indexOf(SHARD_SEP);
  return at === -1 ? 1 : Number(roomId.slice(at + 1)) || 1;
}

function shardId(base, number) {
  return number <= 1 ? base : base + SHARD_SEP + number;
}

/** Primeira sala do grupo com vaga. Se todas estiverem cheias, abre a próxima. */
function pickShard(base) {
  for (let n = 1; n <= MAX_SHARDS; n += 1) {
    const id = shardId(base, n);
    if (roomSize(id) < ROOM_CAPACITY) return id;
  }
  return shardId(base, MAX_SHARDS);
}

/** Dados da sala já com o número da divisão no nome */
function describeRoom(roomId) {
  const base = ROOMS.get(baseRoomId(roomId));
  if (!base) return null;
  const number = shardNumber(roomId);
  return Object.assign({}, base, {
    id: roomId,
    baseId: base.id,
    shard: number,
    capacity: ROOM_CAPACITY,
    name: number > 1 ? `${base.name} · Sala ${number}` : base.name
  });
}

/**
 * Ocupação por sala, somando as divisões: a barra lateral mostra
 * quantas pessoas estão no tema, não em cada pedaço dele.
 */
function roomCounts() {
  const counts = {};
  for (const user of users.values()) {
    if (!user.roomId) continue;
    const base = baseRoomId(user.roomId);
    counts[base] = (counts[base] || 0) + 1;
  }
  return counts;
}

/** Quantas pessoas estão na sala, sem montar a lista toda */
function roomSize(roomId) {
  const room = io.sockets.adapter.rooms.get(roomId);
  return room ? room.size : 0;
}

/**
 * Lista de quem está na sala, cortada em MEMBER_LIST_LIMIT.
 * Numa sala de mil pessoas ninguém rola a lista inteira, e mandar tudo
 * para todo mundo a cada entrada custa caro demais.
 */
function roomMembers(roomId) {
  const members = [];
  for (const [id, user] of users) {
    if (user.roomId === roomId) {
      members.push({ id, nick: user.nick, avatar: user.avatar, color: user.color });
    }
  }
  members.sort((a, b) => a.nick.localeCompare(b.nick, 'pt-BR'));
  return { members: members.slice(0, MEMBER_LIST_LIMIT), total: members.length };
}

function pushHistory(roomId, message) {
  if (!history.has(roomId)) history.set(roomId, []);
  const list = history.get(roomId);
  list.push(message);
  if (list.length > HISTORY_SIZE) list.splice(0, list.length - HISTORY_SIZE);
}

/**
 * Fila de saída por sala. Em sala pequena a mensagem sai na hora; em sala
 * cheia elas viajam juntas a cada BATCH_MS. Numa sala de 250 pessoas isso
 * troca centenas de pacotes por segundo por uns poucos — a conta de banda
 * é o maior custo de um chat, não o processador.
 */
const outbox = new Map();

function deliver(roomId, message) {
  pushHistory(roomId, message);

  if (roomSize(roomId) <= BATCH_ABOVE) {
    io.to(roomId).emit('messages', [message]);
    return;
  }
  if (!outbox.has(roomId)) outbox.set(roomId, []);
  outbox.get(roomId).push(message);
}

function flushOutbox() {
  if (!outbox.size) return;
  for (const [roomId, list] of outbox) {
    if (list.length) io.to(roomId).emit('messages', list);
  }
  outbox.clear();
}

setInterval(flushOutbox, BATCH_MS).unref();

function systemMessage(roomId, text) {
  deliver(roomId, { id: newId(), type: 'system', roomId, text, ts: Date.now() });
}

/**
 * "Fulano entrou/saiu" só faz sentido em sala pequena. Numa sala cheia vira
 * spam ilegível — e um broadcast para todo mundo a cada porta que abre.
 */
function announceComingAndGoing(roomId, text) {
  if (roomSize(roomId) > BUSY_ROOM_SIZE) return;
  systemMessage(roomId, text);
}

let seq = 0;
function newId() {
  seq += 1;
  return Date.now().toString(36) + '-' + seq.toString(36);
}

/** Broadcast leve do mapa de ocupação, para os badges da barra lateral */
let countsTimer = null;
function scheduleCounts() {
  if (countsTimer) return;
  countsTimer = setTimeout(() => {
    countsTimer = null;
    io.emit('counts', { online: users.size, counts: roomCounts() });
  }, COUNTS_INTERVAL_MS);
}

/** Foto completa da sala — só para quem acabou de entrar */
function sendMemberSnapshot(socket, roomId) {
  const { members, total } = roomMembers(roomId);
  socket.emit('members', { roomId, members, total });
}

/**
 * Para os que já estavam na sala, manda só o que mudou (uma pessoa entrou ou saiu).
 * É o que segura sala grande: custo por entrada vira O(n) de rede, não O(n²) de dados.
 */
function broadcastMemberDelta(socket, roomId, event, payload) {
  socket.to(roomId).emit(event, Object.assign({ roomId, total: roomSize(roomId) }, payload));
}

/** true se o usuário estourou o limite de mensagens da janela */
function isFlooding(user) {
  const now = Date.now();
  user.sentAt = user.sentAt.filter((t) => now - t < RATE_WINDOW_MS);
  if (user.sentAt.length >= RATE_MAX_MSGS) return true;
  user.sentAt.push(now);
  return false;
}

// ------------------------------------------------- apoio à moderação

const MOD_ROOM = 'sala-dos-moderadores';

/** Comparação de senha em tempo constante */
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Acha quem está online por apelido, ignorando acento e caixa */
function findUserByNick(nick) {
  const key = nickKey(String(nick || ''));
  if (!key) return null;
  for (const [id, user] of users) {
    if (user.nickKey === key) {
      const socket = io.sockets.sockets.get(id);
      if (socket) return { socket, user };
    }
  }
  return null;
}

/** Avisa quem está de plantão */
function notifyMods(event, data) {
  io.to(MOD_ROOM).emit(event, data);
}

function leaveCurrentRoom(socket, user, { notify = true } = {}) {
  const previous = user.roomId;
  if (!previous) return;
  socket.leave(previous);
  user.roomId = null;
  if (notify) announceComingAndGoing(previous, `${user.nick} saiu da sala`);
  broadcastMemberDelta(socket, previous, 'member-left', { id: socket.id });
}

// ---------------------------------------------------------------- socket.io

io.on('connection', (socket) => {
  const key = mod.identify(socket);

  // banido não entra — nem com F5, nem trocando de apelido
  const standing = mod.activePunishment(key);
  if (standing && standing.type === 'ban') {
    socket.emit('banned', { until: standing.until, reason: standing.reason });
    socket.disconnect(true);
    return;
  }

  const user = {
    nick: 'Visitante',
    nickKey: null,
    key,
    avatar: pick(AVATARS),
    color: pick(NICK_COLORS),
    roomId: null,
    sentAt: [],
    reportAt: [],
    memory: mod.createMemory(),
    isMod: false,
    joined: false
  };
  users.set(socket.id, user);

  socket.emit('welcome', {
    id: socket.id,
    avatars: AVATARS,
    roomCapacity: ROOM_CAPACITY,
    modEnabled: Boolean(MOD_PASSWORD)
  });
  scheduleCounts();

  // se está silenciado, já avisa ao entrar
  if (standing && standing.type === 'mute') {
    socket.emit('muted', { until: standing.until, reason: standing.reason });
  }

  socket.on('check-nick', (payload = {}, ack) => {
    if (typeof ack !== 'function') return;
    const nick = sanitizeNick(payload.nick);
    if (nick.length < MIN_NICK_LEN) return ack({ nick, available: false, error: 'nick-invalid' });
    ack({ nick, available: !isNickTaken(nick, socket.id) });
  });

  socket.on('login', (payload = {}, ack) => {
    const reply = (data) => { if (typeof ack === 'function') ack(data); };
    const requested = sanitizeNick(payload.nick);

    if (requested.length < MIN_NICK_LEN) {
      return reply({
        ok: false,
        error: 'nick-invalid',
        message: `O apelido precisa de pelo menos ${MIN_NICK_LEN} letras.`
      });
    }
    if (isNickTaken(requested, socket.id)) {
      return reply({
        ok: false,
        error: 'nick-taken',
        message: `"${requested}" já está online agora. Escolhe outro.`
      });
    }

    const previousNick = user.joined ? user.nick : null;
    claimNick(user, socket.id, requested);

    if (typeof payload.avatar === 'string' && AVATARS.includes(payload.avatar)) {
      user.avatar = payload.avatar;
    }
    user.joined = true;

    reply({ ok: true, me: { id: socket.id, nick: user.nick, avatar: user.avatar, color: user.color } });

    // trocou de nome no meio do papo: avisa a sala e atualiza a lista
    if (previousNick && previousNick !== user.nick && user.roomId) {
      systemMessage(user.roomId, `${previousNick} agora é ${user.nick}`);
      broadcastMemberDelta(socket, user.roomId, 'member-joined', {
        member: { id: socket.id, nick: user.nick, avatar: user.avatar, color: user.color }
      });
    }
  });

  socket.on('join', (payload = {}, ack) => {
    const reply = (data) => { if (typeof ack === 'function') ack(data); };
    const requested = String(payload.roomId || '');

    if (!ROOMS.has(baseRoomId(requested))) {
      return reply({ ok: false, error: 'Sala inexistente' });
    }
    if (!user.joined) {
      return reply({ ok: false, error: 'Escolha um apelido antes' });
    }

    // se a sala pedida encheu, cai na próxima divisão do mesmo tema
    let roomId = requested;
    if (roomSize(roomId) >= ROOM_CAPACITY && user.roomId !== roomId) {
      roomId = pickShard(baseRoomId(requested));
    }
    const room = describeRoom(roomId);

    if (user.roomId === roomId) {
      return reply({ ok: true, room, history: history.get(roomId) || [] });
    }

    leaveCurrentRoom(socket, user);
    socket.join(roomId);
    user.roomId = roomId;

    reply({ ok: true, room, history: history.get(roomId) || [], movedTo: roomId !== requested ? room.name : null });

    announceComingAndGoing(roomId, `${user.nick} entrou na sala`);
    sendMemberSnapshot(socket, roomId);
    broadcastMemberDelta(socket, roomId, 'member-joined', {
      member: { id: socket.id, nick: user.nick, avatar: user.avatar, color: user.color }
    });
    scheduleCounts();
  });

  socket.on('message', (payload = {}, ack) => {
    const reply = (data) => { if (typeof ack === 'function') ack(data); };
    let text = cleanText(payload.text, MAX_MESSAGE_LEN);
    if (!text || !user.roomId) return reply({ ok: false });

    // silenciado por moderador ou pelo filtro automático
    const punishment = mod.activePunishment(user.key);
    if (punishment && !user.isMod) {
      const left = Math.ceil((punishment.until - Date.now()) / 60_000);
      socket.emit('warning', {
        text: `Você está silenciado por mais ${left} min. Motivo: ${punishment.reason}`
      });
      return reply({ ok: false, error: 'muted' });
    }

    if (!user.isMod && isFlooding(user)) {
      socket.emit('warning', { text: 'Calma, monstro. Você está mandando mensagem rápido demais.' });
      return reply({ ok: false, error: 'flood' });
    }

    // filtro automático: age sozinho, sem depender de moderador acordado
    if (!user.isMod) {
      const verdict = mod.inspect(user.memory, text);
      if (verdict.action === 'mute') {
        mod.punish(user.key, {
          type: 'mute',
          minutes: verdict.minutes,
          reason: verdict.reason,
          nick: user.nick
        });
        socket.emit('warning', { text: `Silenciado por ${verdict.minutes} min. ${verdict.reason}` });
        notifyMods('auto-mute', { nick: user.nick, reason: verdict.reason, minutes: verdict.minutes });
        return reply({ ok: false, error: 'auto-mute' });
      }
      if (verdict.action === 'block') {
        socket.emit('warning', { text: verdict.reason });
        return reply({ ok: false, error: 'blocked' });
      }
      text = verdict.text;
    }

    const message = {
      id: newId(),
      type: 'chat',
      roomId: user.roomId,
      authorId: socket.id,
      nick: user.nick,
      avatar: user.avatar,
      color: user.color,
      mod: user.isMod || undefined,
      text,
      replyTo: payload.replyTo
        ? { nick: cleanText(payload.replyTo.nick, MAX_NICK_LEN), text: cleanText(payload.replyTo.text, 120) }
        : null,
      ts: Date.now()
    };

    deliver(user.roomId, message);
    reply({ ok: true, id: message.id });
  });

  // ---------------------------------------------------------- denúncia

  socket.on('report', (payload = {}, ack) => {
    const reply = (data) => { if (typeof ack === 'function') ack(data); };
    if (!user.joined || !user.roomId) return reply({ ok: false });

    const now = Date.now();
    user.reportAt = user.reportAt.filter((t) => now - t < 60_000);
    if (user.reportAt.length >= 5) return reply({ ok: false, error: 'Muitas denúncias seguidas.' });
    user.reportAt.push(now);

    const report = mod.addReport({
      id: newId(),
      roomId: user.roomId,
      messageId: String(payload.messageId || ''),
      nick: cleanText(payload.nick, MAX_NICK_LEN),
      text: cleanText(payload.text, 200),
      byNick: user.nick,
      ts: now,
      resolved: false
    });

    notifyMods('report', report);
    reply({ ok: true });
  });

  // ---------------------------------------------------------- moderação

  socket.on('mod-login', (payload = {}, ack) => {
    const reply = (data) => { if (typeof ack === 'function') ack(data); };
    if (!MOD_PASSWORD) {
      return reply({ ok: false, message: 'Moderação desligada: falta definir MOD_PASSWORD no servidor.' });
    }
    if (!safeEqual(String(payload.password || ''), MOD_PASSWORD)) {
      console.warn(`  [mod] senha errada de ${user.nick} (${user.key})`);
      return reply({ ok: false, message: 'Senha incorreta.' });
    }

    user.isMod = true;
    socket.join(MOD_ROOM);
    console.log(`  [mod] ${user.nick} entrou como moderador`);
    reply({
      ok: true,
      reports: mod.listReports(30),
      punishments: mod.listPunishments()
    });
  });

  socket.on('mod-action', (payload = {}, ack) => {
    const reply = (data) => { if (typeof ack === 'function') ack(data); };
    if (!user.isMod) return reply({ ok: false, message: 'Você não é moderador.' });

    const action = String(payload.action || '');
    const minutes = Number(payload.minutes) || null;
    const reason = cleanText(payload.reason, 120) || 'sem motivo declarado';

    // ações que miram uma pessoa
    if (['mute', 'ban', 'kick'].includes(action)) {
      const target = findUserByNick(payload.nick);
      if (!target) return reply({ ok: false, message: `Não achei "${payload.nick}" online.` });
      if (target.user.isMod) return reply({ ok: false, message: 'Não dá para punir outro moderador.' });

      if (action === 'kick') {
        target.socket.emit('kicked', { reason });
        target.socket.disconnect(true);
      } else {
        const record = mod.punish(target.user.key, {
          type: action,
          minutes: minutes || (action === 'ban' ? 60 : 10),
          reason,
          by: user.nick,
          nick: target.user.nick
        });
        target.socket.emit(action === 'ban' ? 'banned' : 'muted', { until: record.until, reason });
        if (action === 'ban') target.socket.disconnect(true);
      }

      const verb = { mute: 'silenciou', ban: 'baniu', kick: 'expulsou' }[action];
      console.log(`  [mod] ${user.nick} ${verb} ${target.user.nick}: ${reason}`);
      notifyMods('mod-log', { by: user.nick, action, nick: target.user.nick, reason });
      return reply({ ok: true, message: `Você ${verb} ${target.user.nick}.` });
    }

    if (action === 'pardon') {
      const wanted = nickKey(String(payload.nick || ''));
      const records = mod.listPunishments().filter((p) => p.nick && nickKey(p.nick) === wanted);
      if (!records.length) return reply({ ok: false, message: 'Ninguém com esse apelido está de castigo.' });
      records.forEach((r) => mod.pardon(r.key));
      return reply({ ok: true, message: `${records[0].nick} está liberado.` });
    }

    if (action === 'delete') {
      const roomId = String(payload.roomId || user.roomId || '');
      const list = history.get(roomId);
      if (list) {
        const at = list.findIndex((m) => m.id === payload.messageId);
        if (at !== -1) list.splice(at, 1);
      }
      io.to(roomId).emit('message-deleted', { roomId, id: String(payload.messageId || '') });
      notifyMods('mod-log', { by: user.nick, action: 'delete', nick: payload.nick || '—', reason });
      return reply({ ok: true, message: 'Mensagem apagada.' });
    }

    if (action === 'clear') {
      const roomId = String(payload.roomId || user.roomId || '');
      history.set(roomId, []);
      io.to(roomId).emit('room-cleared', { roomId });
      systemMessage(roomId, `A sala foi limpa por ${user.nick}`);
      return reply({ ok: true, message: 'Sala limpa.' });
    }

    if (action === 'list') {
      return reply({ ok: true, punishments: mod.listPunishments(), reports: mod.listReports(30) });
    }

    reply({ ok: false, message: 'Ação desconhecida.' });
  });

  socket.on('typing', (payload = {}) => {
    if (!user.roomId) return;
    socket.to(user.roomId).emit('typing', {
      id: socket.id,
      nick: user.nick,
      typing: Boolean(payload.typing)
    });
  });

  socket.on('leave', () => {
    leaveCurrentRoom(socket, user);
    scheduleCounts();
  });

  socket.on('disconnect', () => {
    const previous = user.roomId;
    if (previous) {
      user.roomId = null;
      announceComingAndGoing(previous, `${user.nick} saiu da sala`);
    }
    releaseNick(user, socket.id);   // o apelido volta a ficar livre
    users.delete(socket.id);
    if (previous) broadcastMemberDelta(socket, previous, 'member-left', { id: socket.id });
    scheduleCounts();
  });
});

server.listen(PORT, () => {
  console.log(`\n  CHATMAROMBA rodando em http://localhost:${PORT}`);
  console.log(`  ${ROOMS.size} salas disponíveis (${THEMES.length} temas, ${STATES.length} estados)\n`);
});

// os hosts mandam SIGTERM antes de reiniciar: fecha as conexões com jeito
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`\n  ${signal} recebido, encerrando...`);
    io.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
