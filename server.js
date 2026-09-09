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
const guard = require('./shared/guard');
const photos = require('./shared/photos');
const terms = require('./shared/terms');
const profile = require('./shared/profile');

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

const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGIN },
  /**
   * O padrão do socket.io aceita 1 MB por evento. Nenhuma mensagem legítima
   * daqui passa de 500 caracteres, então 16 KB já é folgado — e corta na raiz
   * o truque de encher a memória mandando eventos gigantes.
   */
  maxHttpBufferSize: 16 * 1024,
  pingInterval: 25_000,
  pingTimeout: 20_000,
  connectTimeout: 20_000
});

app.disable('x-powered-by');   // não anuncia o que roda aqui dentro
app.set('trust proxy', guard.BEHIND_PROXY ? 1 : false);   // só confia se houver proxy mesmo

/**
 * Content-Security-Policy: mesmo que uma falha de escape passasse, o navegador
 * se recusaria a rodar script que não venha daqui. É a segunda tranca da porta.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  // blob: é obrigatório aqui: é assim que o navegador abre a foto que a
  // pessoa acabou de escolher, antes de cortar e enviar. Sem isso, a
  // própria trava de segurança impede alguém de colocar foto de perfil.
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss:",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'"
].join('; ');

app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

app.use(guard.httpLimiter({ nome: 'navegacao', perMinute: 300, burst: 90 }));
guard.startJanitor();

/**
 * Cache dos estáticos.
 *
 * Com max-age longo, o navegador segurava o app.js por uma hora sem nem
 * perguntar ao servidor. Depois de um deploy, a pessoa ficava rodando o
 * código antigo contra o servidor novo — e o resultado é uma tela que
 * simplesmente não responde, sem erro nenhum visível.
 *
 * "no-cache" não quer dizer "não guarde": quer dizer "guarde, mas pergunte
 * antes de usar". A resposta é um 304 de alguns bytes quando nada mudou,
 * e o arquivo novo assim que muda. Para uma página de 30 KB isso não pesa,
 * e elimina de vez a classe de bug "o usuário está com a versão velha".
 *
 * A foto é a exceção: o endereço dela é o hash do conteúdo, então o mesmo
 * endereço nunca muda de imagem e pode ficar guardado para sempre.
 */
app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'ignore',
  index: 'index.html',
  etag: true,
  lastModified: true,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.get('/api/rooms', (_req, res) => {
  res.json({ themes: THEMES, states: STATES });
});

app.get('/api/terms', (_req, res) => {
  res.json({ versao: terms.VERSAO, intro: terms.INTRO, secoes: terms.SECOES, idade: terms.IDADE });
});

app.get('/api/stats', (_req, res) => {
  res.json({ online: users.size, counts: roomCounts() });
});

/**
 * Envio da foto de perfil.
 *
 * Vai por HTTP e não pelo socket de propósito: o socket tem teto de 16 KB,
 * que é o que impede o ataque de evento gigante. Afrouxar aquele limite para
 * caber foto reabriria o buraco. Aqui o limite é próprio e bem mais apertado
 * que qualquer foto de câmera — o navegador já mandou ela encolhida.
 */
app.post('/api/avatar',
  guard.httpLimiter({ nome: 'upload-foto', perMinute: 10, burst: 6 }),
  express.raw({ type: 'image/jpeg', limit: photos.MAX_BYTES }),
  (req, res) => {
    const token = String(req.get('x-device-token') || '');
    if (token.length < 8) return res.status(400).json({ error: 'sem identidade' });

    const resultado = photos.save(req.body, mod.tokenKey(token));
    if (!resultado.ok) return res.status(400).json({ error: resultado.error });

    res.json({ ok: true, id: resultado.id });
  });

/**
 * Entrega da foto. Três cuidados aqui:
 *  - o tipo é fixo em image/jpeg, nunca o que o usuário disse que era
 *  - nosniff impede o navegador de "adivinhar" outro tipo e executar algo
 *  - o id é o hash do conteúdo, então pode cachear para sempre sem errar
 */
app.get('/avatar/:id', (req, res) => {
  const foto = photos.get(req.params.id);
  if (!foto) return res.status(404).end();

  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.end(foto.bytes);
});

app.get('/health', (_req, res) => res.json({
  ok: true,
  uptime: process.uptime(),
  sockets: users.size,
  memory: process.memoryUsage(),
  guard: guard.snapshot(),
  fotos: photos.snapshot()
}));

// nada além do que está mapeado acima
app.use((_req, res) => res.status(404).json({ error: 'não existe' }));

// ---------------------------------------------------------------- helpers

/** Estado "ainda não escolhi nada": a silhueta do chat */
const SEM_ESCOLHA = '👤';

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
      members.push({ id, nick: user.nick, avatar: user.avatar, color: user.color, photo: user.photo });
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

  // teto de conexões: impede que um script sozinho ocupe a máquina inteira
  const admission = guard.admit(key.ipKey, users.size);
  if (!admission.ok) {
    console.warn(`  [guard] conexão recusada: ${admission.reason}`);
    socket.emit('overloaded', { text: 'Muita gente entrando agora. Tenta de novo em instantes.' });
    socket.disconnect(true);
    return;
  }
  socket.once('disconnect', () => guard.release(key.ipKey));

  const user = {
    nick: 'Visitante',
    nickKey: null,
    key,
    budget: guard.createBudget(),
    avatar: SEM_ESCOLHA,
    color: pick(NICK_COLORS),
    roomId: null,
    sentAt: [],
    reportAt: [],
    memory: mod.createMemory(),
    photo: null,
    acceptedTerms: false,
    profile: profile.vazio(),
    isMod: false,
    joined: false
  };
  users.set(socket.id, user);

  /**
   * Freio por evento. Quem estoura a cota é ignorado em silêncio — sem
   * mensagem de erro detalhada, que só ajudaria quem está testando o limite.
   */
  const within = (event, ack) => {
    if (guard.allow(user.budget, event)) return true;
    if (typeof ack === 'function') {
      ack({ ok: false, error: 'rate-limit', message: 'Devagar aí. Tenta de novo em instantes.' });
    }
    return false;
  };

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
    if (!within('check-nick', ack)) return;
    const nick = sanitizeNick(payload.nick);
    if (nick.length < MIN_NICK_LEN) return ack({ nick, available: false, error: 'nick-invalid' });
    ack({ nick, available: !isNickTaken(nick, socket.id) });
  });

  socket.on('login', (payload = {}, ack) => {
    const reply = (data) => { if (typeof ack === 'function') ack(data); };
    if (!within('login', ack)) return;
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

    // silhueta é escolha válida: quem não quis emoji nem foto entra assim
    if (typeof payload.avatar === 'string'
        && (AVATARS.includes(payload.avatar) || payload.avatar === SEM_ESCOLHA)) {
      user.avatar = payload.avatar;
    } else if (!payload.avatar) {
      user.avatar = SEM_ESCOLHA;
    }
    user.joined = true;
    // só vale o aceite da versão que está no ar; regra nova exige aceite novo
    if (String(payload.terms || '') === terms.VERSAO) user.acceptedTerms = true;

    reply({ ok: true, termsVersion: terms.VERSAO, me: { id: socket.id, nick: user.nick, avatar: user.avatar, color: user.color, photo: user.photo } });

    // trocou de nome no meio do papo: avisa a sala e atualiza a lista
    if (previousNick && previousNick !== user.nick && user.roomId) {
      systemMessage(user.roomId, `${previousNick} agora é ${user.nick}`);
      broadcastMemberDelta(socket, user.roomId, 'member-joined', {
        member: { id: socket.id, nick: user.nick, avatar: user.avatar, color: user.color, photo: user.photo }
      });
    }
  });

  /**
   * Adota a foto já enviada por HTTP. O id é conferido contra a identidade
   * de quem subiu, senão daria para vestir a foto de outra pessoa.
   */
  socket.on('set-photo', (payload = {}, ack) => {
    const reply = (data) => { if (typeof ack === 'function') ack(data); };
    if (!within('set-photo', ack)) return;

    const id = String(payload.id || '');

    if (!id) {                                  // voltar para o emoji
      user.photo = null;
      atualizarRetrato();
      return reply({ ok: true, photo: null });
    }
    if (!photos.ownedBy(id, user.key.tokenKey)) {
      return reply({ ok: false, message: 'Essa foto não é sua.' });
    }

    user.photo = id;
    atualizarRetrato();
    reply({ ok: true, photo: id });
  });

  /** avisa a sala que o retrato mudou, sem precisar recarregar nada */
  function atualizarRetrato() {
    if (!user.roomId) return;
    broadcastMemberDelta(socket, user.roomId, 'member-joined', {
      member: {
        id: socket.id, nick: user.nick, avatar: user.avatar,
        color: user.color, photo: user.photo
      }
    });
  }

  socket.on('set-profile', (payload = {}, ack) => {
    const reply = (data) => { if (typeof ack === 'function') ack(data); };
    if (!within('set-profile', ack)) return;

    const resultado = profile.montar(payload);
    if (!resultado.ok) return reply({ ok: false, message: resultado.motivo });

    user.profile = resultado.perfil;
    reply({ ok: true, perfil: user.profile });
  });

  /**
   * Cartão de visita de alguém da sala. Vai sob demanda, no clique, e não
   * junto de cada mensagem: repetir cidade, idade e frase em toda linha
   * multiplicaria a banda sem ninguém pedir.
   */
  socket.on('get-profile', (payload = {}, ack) => {
    const reply = (data) => { if (typeof ack === 'function') ack(data); };
    if (!within('get-profile', ack)) return;

    const alvo = users.get(String(payload.id || ''));
    if (!alvo || !alvo.joined) {
      return reply({ ok: false, message: 'Essa pessoa saiu do chat.' });
    }

    const perfil = alvo.profile || profile.vazio();
    reply({
      ok: true,
      perfil: {
        nick: alvo.nick,
        avatar: alvo.avatar,
        color: alvo.color,
        photo: alvo.photo || null,
        mod: alvo.isMod || false,
        // só vai o que a pessoa realmente preencheu
        cidade: perfil.cidade,
        idade: perfil.idade,
        frase: perfil.frase,
        instagram: perfil.instagram,
        instagramHandle: perfil.instagramHandle,
        preenchido: profile.temAlgo(perfil)
      }
    });
  });

  socket.on('join', (payload = {}, ack) => {
    const reply = (data) => { if (typeof ack === 'function') ack(data); };
    if (!within('join', ack)) return;
    const requested = String(payload.roomId || '');

    /**
     * O nome da sala vem do cliente, então precisa passar por porteiro:
     * o tema tem que existir E o número da divisão tem que estar na faixa.
     * Sem isso, dava para pedir "tema:geral~999999" e fabricar salas
     * fantasma sem limite, cada uma comendo um pedaço da memória.
     */
    if (!ROOMS.has(baseRoomId(requested)) || requested.length > 80) {
      return reply({ ok: false, error: 'Sala inexistente' });
    }
    const askedShard = shardNumber(requested);
    if (!Number.isInteger(askedShard) || askedShard < 1 || askedShard > MAX_SHARDS
        || shardId(baseRoomId(requested), askedShard) !== requested) {
      return reply({ ok: false, error: 'Sala inexistente' });
    }
    if (!user.joined) {
      return reply({ ok: false, error: 'Escolha um apelido antes' });
    }
    /**
     * Sem aceite das regras, ninguém entra em sala. A checagem é aqui no
     * servidor de propósito: travar só na tela seria enfeite, bastaria falar
     * direto com o socket para pular. É isto que dá base para banir depois.
     */
    if (!user.acceptedTerms) {
      return reply({ ok: false, error: 'terms', message: 'Você precisa aceitar as regras antes de entrar.' });
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
      member: { id: socket.id, nick: user.nick, avatar: user.avatar, color: user.color, photo: user.photo }
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
      photo: user.photo || undefined,
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
    if (!within('report', ack)) return;
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
      photo: cleanText(payload.photo, 40) || null,
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
    if (!within('mod-login', ack)) return;
    if (!MOD_PASSWORD) {
      return reply({ ok: false, message: 'Moderação desligada: falta definir MOD_PASSWORD no servidor.' });
    }
    if (!safeEqual(String(payload.password || '').slice(0, 200), MOD_PASSWORD)) {
      const espera = guard.cooldown(user.budget, 'mod-login');
      console.warn(`  [mod] senha errada de "${user.nick}" (${user.key.ipKey})`);
      return reply({
        ok: false,
        message: espera
          ? `Senha incorreta. Novas tentativas só em ${Math.ceil(espera / 60)} min.`
          : 'Senha incorreta.'
      });
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
    if (!within('mod-action', ack)) return;
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
        if (action === 'ban') {
          // quem é banido leva a foto junto: não faz sentido ela continuar de pé
          if (target.user.photo) photos.remove(target.user.photo);
          target.socket.disconnect(true);
        }
      }

      const verb = { mute: 'silenciou', ban: 'baniu', kick: 'expulsou' }[action];
      console.log(`  [mod] ${user.nick} ${verb} ${target.user.nick}: ${reason}`);
      notifyMods('mod-log', { by: user.nick, action, nick: target.user.nick, reason });
      return reply({ ok: true, message: `Você ${verb} ${target.user.nick}.` });
    }

    /**
     * Apagar a foto de alguém. Some para todo mundo na hora, inclusive das
     * mensagens antigas, porque o id da foto deixa de existir no servidor.
     */
    if (action === 'photo') {
      const alvo = findUserByNick(payload.nick);
      if (!alvo) return reply({ ok: false, message: `Não achei "${payload.nick}" online.` });
      if (!alvo.user.photo) return reply({ ok: false, message: 'Essa pessoa não tem foto.' });

      photos.remove(alvo.user.photo);
      alvo.user.photo = null;
      alvo.socket.emit('photo-removed', { reason });
      if (alvo.user.roomId) {
        io.to(alvo.user.roomId).emit('member-joined', {
          roomId: alvo.user.roomId,
          total: roomSize(alvo.user.roomId),
          member: {
            id: alvo.socket.id, nick: alvo.user.nick, avatar: alvo.user.avatar,
            color: alvo.user.color, photo: null
          }
        });
      }
      console.log(`  [mod] ${user.nick} apagou a foto de ${alvo.user.nick}: ${reason}`);
      notifyMods('mod-log', { by: user.nick, action: 'photo', nick: alvo.user.nick, reason });
      return reply({ ok: true, message: `Foto de ${alvo.user.nick} apagada.` });
    }

    /**
     * Limpar o perfil de alguém. O campo do Instagram é o alvo mais provável
     * de quem quer divulgar, então precisa ter remédio rápido.
     */
    if (action === 'wipe-profile') {
      const alvo = findUserByNick(payload.nick);
      if (!alvo) return reply({ ok: false, message: `Não achei "${payload.nick}" online.` });

      alvo.user.profile = profile.vazio();
      alvo.socket.emit('profile-wiped', { reason });
      console.log(`  [mod] ${user.nick} limpou o perfil de ${alvo.user.nick}: ${reason}`);
      notifyMods('mod-log', { by: user.nick, action: 'wipe-profile', nick: alvo.user.nick, reason });
      return reply({ ok: true, message: `Perfil de ${alvo.user.nick} limpo.` });
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
    if (!guard.allow(user.budget, 'typing')) return;
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
