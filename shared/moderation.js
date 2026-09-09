/**
 * Moderação do CHATMAROMBA.
 *
 * Três partes:
 *  1. Identidade de conexão (IP com hash) para castigo sobreviver ao F5
 *  2. Castigos: silenciar e banir, com prazo
 *  3. Filtro automático de spam, que age sem moderador humano acordado
 *
 * O IP nunca é guardado em claro: vira um hash com sal sorteado a cada boot.
 * Isso basta para castigar quem está online agora e não deixa rastro depois.
 */

const crypto = require('crypto');
const guard = require('./guard');

const SALT = process.env.IP_SALT || crypto.randomBytes(16).toString('hex');

const REPEAT_LIMIT = 3;            // mesma mensagem seguida
const REPEAT_MUTE_MIN = 2;
const LINK_WINDOW_MS = 30_000;
const LINK_LIMIT = 4;              // mensagens com link na janela
const LINK_MUTE_MIN = 5;
const MAX_LINKS_PER_MSG = 2;
const CAPS_MIN_LEN = 15;
const CAPS_RATIO = 0.7;
const REPORTS_MAX = 300;

/** castigoKey -> { type, until, reason, by, nick } */
const punishments = new Map();
/** denúncias recentes, da mais nova para a mais velha */
const reports = [];

/**
 * Banir por IP é perigoso no Brasil: as operadoras móveis usam CGNAT, então
 * milhares de pessoas dividem o mesmo endereço. Derrubar um IP pode calar
 * uma cidade inteira sem querer.
 *
 * Por isso a identidade principal é um token que o navegador guarda. O IP
 * entra só como reforço no banimento (para não bastar limpar o navegador),
 * e dá para desligar esse reforço com BAN_BY_IP=0.
 */
const BAN_BY_IP = process.env.BAN_BY_IP !== '0';

function hash(value) {
  return crypto.createHash('sha256').update(value + SALT).digest('hex').slice(0, 16);
}

/** Identidade da conexão: token do navegador + IP, ambos com hash */
function identify(socket) {
  const auth = socket.handshake.auth || {};
  const token = typeof auth.token === 'string' && auth.token.length >= 8 ? auth.token : null;
  const ip = guard.clientIp(socket.handshake.headers, socket.handshake.address);

  return {
    tokenKey: token ? hash('t:' + token) : null,
    ipKey: hash('i:' + ip),
    /** chave usada para silenciar: nunca o IP puro, para não pegar inocente */
    get muteKey() { return this.tokenKey || this.ipKey; }
  };
}

/** Castigo em uma chave específica, já limpando o que venceu */
function punishmentAt(key) {
  if (!key) return null;
  const found = punishments.get(key);
  if (!found) return null;
  if (found.until <= Date.now()) {
    punishments.delete(key);
    return null;
  }
  return found;
}

/**
 * Castigo válido para esta identidade.
 * Silêncio vale pelo token; banimento vale também pelo IP.
 */
function activePunishment(identity) {
  if (typeof identity === 'string') return punishmentAt(identity);   // uso interno
  const byToken = punishmentAt(identity.tokenKey);
  if (byToken) return byToken;
  const byIp = punishmentAt(identity.ipKey);
  return byIp && byIp.type === 'ban' ? byIp : null;
}

function punish(identity, { type, minutes, reason, by, nick }) {
  const record = {
    type,
    nick: nick || null,
    reason: reason || 'sem motivo declarado',
    by: by || 'automático',
    until: Date.now() + Math.max(1, Number(minutes) || 1) * 60_000
  };

  if (typeof identity === 'string') {
    punishments.set(identity, record);
    return record;
  }

  punishments.set(identity.muteKey, record);
  // banimento também prende o IP, senão bastava limpar o navegador
  if (type === 'ban' && BAN_BY_IP && identity.ipKey !== identity.muteKey) {
    punishments.set(identity.ipKey, record);
  }
  return record;
}

function pardon(identity) {
  if (typeof identity === 'string') return punishments.delete(identity);
  let removed = punishments.delete(identity.muteKey);
  if (identity.ipKey) removed = punishments.delete(identity.ipKey) || removed;
  return removed;
}

/** Lista de castigos válidos, para o painel do moderador */
function listPunishments() {
  const now = Date.now();
  const list = [];
  for (const [key, record] of punishments) {
    if (record.until <= now) { punishments.delete(key); continue; }
    list.push(Object.assign({ key }, record));
  }
  return list.sort((a, b) => b.until - a.until);
}

function addReport(report) {
  reports.unshift(report);
  if (reports.length > REPORTS_MAX) reports.length = REPORTS_MAX;
  return report;
}

function listReports(limit = 50) {
  return reports.slice(0, limit);
}

function resolveReport(id) {
  const found = reports.find((r) => r.id === id);
  if (found) found.resolved = true;
  return Boolean(found);
}

function countLinks(text) {
  const matches = text.match(/https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|br|io|me|gg|xyz|shop|link)\b/gi);
  return matches ? matches.length : 0;
}

function capsRatio(text) {
  const letters = text.replace(/[^a-zA-ZÀ-ÿ]/g, '');
  if (letters.length < CAPS_MIN_LEN) return 0;
  const upper = letters.replace(/[^A-ZÀ-Þ]/g, '').length;
  return upper / letters.length;
}

/**
 * Olha a mensagem antes dela virar pública.
 * Devolve { action, text, reason, minutes }:
 *   allow  — pode passar (text pode vir suavizado)
 *   block  — descarta e avisa quem mandou
 *   mute   — descarta, avisa e silencia por `minutes`
 *
 * `memory` é o estado do usuário, criado por createMemory().
 */
function inspect(memory, rawText) {
  let text = rawText;
  const now = Date.now();

  // 1. caracteres esticados: "aeeeeeeeeeee" vira "aeee"
  text = text.replace(/(.)\1{4,}/g, (_m, ch) => ch.repeat(3));

  // 2. grito: não bloqueia, só abaixa a voz
  if (capsRatio(text) > CAPS_RATIO) {
    text = text.charAt(0) + text.slice(1).toLowerCase();
  }

  // 3. muro de links numa mensagem só
  const links = countLinks(text);
  if (links > MAX_LINKS_PER_MSG) {
    return { action: 'block', text, reason: 'Link demais numa mensagem só.' };
  }

  // 4. insistência em link ao longo do tempo
  if (links > 0) {
    memory.linkAt = memory.linkAt.filter((t) => now - t < LINK_WINDOW_MS);
    memory.linkAt.push(now);
    if (memory.linkAt.length >= LINK_LIMIT) {
      memory.linkAt = [];
      return {
        action: 'mute',
        minutes: LINK_MUTE_MIN,
        text,
        reason: 'Muito link em pouco tempo. Isso aqui não é mural de divulgação.'
      };
    }
  }

  // 5. mesma mensagem repetida
  const key = text.toLowerCase();
  if (key === memory.lastText) {
    memory.repeatCount += 1;
    if (memory.repeatCount >= REPEAT_LIMIT) {
      memory.repeatCount = 0;
      memory.lastText = null;
      return {
        action: 'mute',
        minutes: REPEAT_MUTE_MIN,
        text,
        reason: 'Você repetiu a mesma mensagem várias vezes seguidas.'
      };
    }
  } else {
    memory.lastText = key;
    memory.repeatCount = 0;
  }

  return { action: 'allow', text };
}

/** Estado por usuário que o inspect() precisa lembrar */
function createMemory() {
  return { lastText: null, repeatCount: 0, linkAt: [] };
}

/** Mesma chave que identify() usa, para quem só tem o token em mãos */
function tokenKey(token) {
  return hash('t:' + String(token));
}

module.exports = {
  identify,
  tokenKey,
  activePunishment,
  punish,
  pardon,
  listPunishments,
  addReport,
  listReports,
  resolveReport,
  inspect,
  createMemory
};
