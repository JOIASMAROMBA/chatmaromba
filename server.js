/**
 * CHATMAROMBA — servidor de bate-papo em tempo real.
 * Express (estáticos + API) + Socket.IO (mensagens).
 * Estado em memória: nada é persistido em disco.
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { THEMES, STATES, buildRooms } = require('./shared/rooms');

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

/** Contagem de gente online por sala, só das salas com alguém dentro */
function roomCounts() {
  const counts = {};
  for (const user of users.values()) {
    if (user.roomId) counts[user.roomId] = (counts[user.roomId] || 0) + 1;
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

function systemMessage(roomId, text) {
  const message = { id: newId(), type: 'system', roomId, text, ts: Date.now() };
  pushHistory(roomId, message);
  io.to(roomId).emit('message', message);
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
  const user = {
    nick: 'Visitante',
    nickKey: null,
    avatar: pick(AVATARS),
    color: pick(NICK_COLORS),
    roomId: null,
    sentAt: [],
    joined: false
  };
  users.set(socket.id, user);

  socket.emit('welcome', { id: socket.id, avatars: AVATARS });
  scheduleCounts();

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
    const roomId = String(payload.roomId || '');
    const room = ROOMS.get(roomId);
    if (!room) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Sala inexistente' });
      return;
    }
    if (!user.joined) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Escolha um apelido antes' });
      return;
    }
    if (user.roomId === roomId) {
      if (typeof ack === 'function') ack({ ok: true, room, history: history.get(roomId) || [] });
      return;
    }

    leaveCurrentRoom(socket, user);
    socket.join(roomId);
    user.roomId = roomId;

    if (typeof ack === 'function') {
      ack({ ok: true, room, history: history.get(roomId) || [] });
    }
    announceComingAndGoing(roomId, `${user.nick} entrou na sala`);
    sendMemberSnapshot(socket, roomId);
    broadcastMemberDelta(socket, roomId, 'member-joined', {
      member: { id: socket.id, nick: user.nick, avatar: user.avatar, color: user.color }
    });
    scheduleCounts();
  });

  socket.on('message', (payload = {}, ack) => {
    const text = cleanText(payload.text, MAX_MESSAGE_LEN);
    if (!text || !user.roomId) {
      if (typeof ack === 'function') ack({ ok: false });
      return;
    }
    if (isFlooding(user)) {
      socket.emit('warning', { text: 'Calma, monstro. Você está mandando mensagem rápido demais.' });
      if (typeof ack === 'function') ack({ ok: false, error: 'flood' });
      return;
    }

    const message = {
      id: newId(),
      type: 'chat',
      roomId: user.roomId,
      authorId: socket.id,
      nick: user.nick,
      avatar: user.avatar,
      color: user.color,
      text,
      replyTo: payload.replyTo
        ? { nick: cleanText(payload.replyTo.nick, MAX_NICK_LEN), text: cleanText(payload.replyTo.text, 120) }
        : null,
      ts: Date.now()
    };

    pushHistory(user.roomId, message);
    io.to(user.roomId).emit('message', message);
    if (typeof ack === 'function') ack({ ok: true, id: message.id });
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
