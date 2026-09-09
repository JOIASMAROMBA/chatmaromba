/**
 * Proteção contra abuso do CHATMAROMBA.
 *
 * O objetivo não é impedir um ataque com botnet — isso é trabalho da camada
 * de rede da Fly e, se um dia precisar, de um Cloudflare na frente. O que
 * este arquivo faz é impedir que UMA pessoa com um script derrube o chat de
 * todo mundo, que é o ataque realista contra um site desse tamanho.
 *
 * Cuidado permanente: no Brasil, operadora móvel usa CGNAT. Milhares de
 * pessoas dividem um IP. Por isso todo limite por IP aqui é generoso de
 * propósito — barrar cedo demais derruba gente inocente, e um chat vazio
 * por excesso de zelo é tão inútil quanto um chat derrubado.
 */

const num = (name, fallback) => Number(process.env[name] || fallback);

/**
 * Quantos proxies confiáveis existem na frente. Na Fly é 1.
 * Só as entradas colocadas por eles valem; o resto o cliente escreve.
 */
const TRUSTED_HOPS = num('TRUSTED_PROXY_HOPS', 1);

/**
 * Só existe proxy confiável na frente quando estamos hospedados.
 * Rodando direto (na sua máquina, ou numa porta exposta sem proxy), o
 * cabeçalho X-Forwarded-For é 100% invenção do cliente e tem que ser
 * ignorado — senão qualquer um troca de identidade quando quiser.
 * Force com TRUST_PROXY=1 ou desligue com TRUST_PROXY=0.
 */
const BEHIND_PROXY = process.env.TRUST_PROXY
  ? process.env.TRUST_PROXY !== '0'
  : Boolean(process.env.FLY_APP_NAME || process.env.RENDER || process.env.RAILWAY_ENVIRONMENT);

/**
 * Descobre o IP real de quem está do outro lado.
 *
 * Cuidado que custou um bug: qualquer pessoa pode mandar o cabeçalho
 * "X-Forwarded-For: 1.2.3.4" na própria requisição. O proxy não apaga isso,
 * ele ACRESCENTA o endereço verdadeiro no fim da lista. Então o primeiro
 * item é o que o cliente inventou, e o último é o que o proxy garantiu.
 * Ler o primeiro deixaria qualquer um trocar de identidade à vontade e
 * furar limite e banimento.
 */
function clientIp(headers = {}, fallback) {
  const direto = (fallback && String(fallback)) || 'desconhecido';

  // sem proxy na frente, cabeçalho de encaminhamento não vale nada
  if (!BEHIND_PROXY) return direto;

  // a Fly escreve este e sobrescreve o que o cliente tiver mandado
  const fly = headers['fly-client-ip'];
  if (fly) return String(fly).trim();

  const forwarded = headers['x-forwarded-for'];
  if (forwarded) {
    const hops = String(forwarded).split(',').map((p) => p.trim()).filter(Boolean);
    const trusted = hops[hops.length - TRUSTED_HOPS];
    if (trusted) return trusted;
  }

  return direto;
}

/** Teto global de conexões: acima disso a máquina começa a sofrer */
const MAX_SOCKETS_TOTAL = num('MAX_SOCKETS_TOTAL', 3000);
/** Por IP. Alto de propósito, por causa do CGNAT. */
const MAX_SOCKETS_PER_IP = num('MAX_SOCKETS_PER_IP', 120);
/** Conexões novas por minuto vindas do mesmo IP */
const NEW_PER_MINUTE_PER_IP = num('NEW_PER_MINUTE_PER_IP', 90);

/**
 * Orçamento de eventos por conexão. Cada entrada é [quantidade, janela em ms].
 * Estourar não derruba ninguém: o evento é só ignorado.
 */
const BUDGETS = {
  join: [25, 60_000],
  typing: [60, 10_000],
  'check-nick': [40, 60_000],
  report: [5, 60_000],
  login: [12, 60_000],
  'mod-action': [60, 60_000],
  'set-photo': [10, 300_000],
  'set-profile': [20, 300_000],
  'get-profile': [90, 60_000],
  'mod-login': [5, 600_000]      // senha: 5 tentativas a cada 10 minutos
};

/** ipKey -> quantas conexões abertas agora */
const openByIp = new Map();
/** ipKey -> instantes das conexões recentes */
const recentByIp = new Map();

/**
 * Contadores de recusa. Existem porque o limite certo por IP é um chute:
 * depende de quanta gente a operadora empilha atrás do mesmo endereço.
 * Se "porIp" aqui começar a subir com o chat funcionando normal, o limite
 * está apertado demais e está barrando gente de verdade — suba o
 * MAX_SOCKETS_PER_IP em vez de deixar usuário na porta.
 */
const refused = { total: 0, porIp: 0, novasPorMinuto: 0, httpFlood: 0 };
/** pico de conexões simultâneas vindas de um mesmo IP */
let maiorPorIp = 0;

function pruneTimestamps(list, windowMs, now) {
  let cut = 0;
  while (cut < list.length && now - list[cut] >= windowMs) cut += 1;
  if (cut) list.splice(0, cut);
  return list;
}

/**
 * Decide se aceita mais uma conexão.
 * Devolve { ok, reason } — reason vai para o log, nunca para o atacante.
 */
function admit(ipKey, totalSockets) {
  if (totalSockets >= MAX_SOCKETS_TOTAL) {
    refused.total += 1;
    return { ok: false, reason: 'servidor no teto de conexões' };
  }

  const now = Date.now();
  const recent = pruneTimestamps(recentByIp.get(ipKey) || [], 60_000, now);
  if (recent.length >= NEW_PER_MINUTE_PER_IP) {
    recentByIp.set(ipKey, recent);
    refused.novasPorMinuto += 1;
    return { ok: false, reason: 'conexões novas demais vindas do mesmo IP' };
  }

  const open = openByIp.get(ipKey) || 0;
  if (open >= MAX_SOCKETS_PER_IP) {
    refused.porIp += 1;
    return { ok: false, reason: 'muitas conexões abertas do mesmo IP' };
  }

  recent.push(now);
  recentByIp.set(ipKey, recent);
  openByIp.set(ipKey, open + 1);
  if (open + 1 > maiorPorIp) maiorPorIp = open + 1;
  return { ok: true };
}

function release(ipKey) {
  const open = (openByIp.get(ipKey) || 1) - 1;
  if (open <= 0) openByIp.delete(ipKey);
  else openByIp.set(ipKey, open);
}

/** Carteira de orçamentos de uma conexão */
function createBudget() {
  return new Map();
}

/**
 * Consome uma unidade do orçamento do evento.
 * Devolve true se pode seguir, false se estourou a cota.
 */
function allow(budget, event) {
  const rule = BUDGETS[event];
  if (!rule) return true;

  const [limit, windowMs] = rule;
  const now = Date.now();
  const list = pruneTimestamps(budget.get(event) || [], windowMs, now);

  if (list.length >= limit) {
    budget.set(event, list);
    return false;
  }
  list.push(now);
  budget.set(event, list);
  return true;
}

/** Quanto falta para a cota do evento voltar, em segundos */
function cooldown(budget, event) {
  const rule = BUDGETS[event];
  const list = budget.get(event);
  if (!rule || !list || !list.length) return 0;
  return Math.max(0, Math.ceil((list[0] + rule[1] - Date.now()) / 1000));
}

// ---------------------------------------------------------------- HTTP

/** ip -> { tokens, updatedAt } */
const httpBuckets = new Map();

/**
 * Freio de requisições HTTP, em balde de fichas.
 * Generoso: uma pessoa carregando a página gasta poucas fichas, mas um
 * script batendo em looping seca o balde rápido.
 */
function httpLimiter({ nome = 'geral', perMinute = 240, burst = 60 } = {}) {
  const refillPerMs = perMinute / 60_000;

  return function limiter(req, res, next) {
    const ip = clientIp(req.headers, req.socket && req.socket.remoteAddress);
    // cada limitador tem o próprio balde: sem o nome na chave, o limite
    // frouxo da navegação encheria o balde do limite apertado do upload
    const chave = nome + '|' + ip;
    const now = Date.now();
    const bucket = httpBuckets.get(chave) || { tokens: burst, updatedAt: now };

    bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);
    bucket.updatedAt = now;

    if (bucket.tokens < 1) {
      httpBuckets.set(chave, bucket);
      refused.httpFlood += 1;
      res.setHeader('Retry-After', '30');
      return res.status(429).json({ error: 'Devagar. Tenta de novo em alguns segundos.' });
    }

    bucket.tokens -= 1;
    httpBuckets.set(chave, bucket);
    next();
  };
}

/** Limpeza periódica, para os mapas não crescerem para sempre */
function startJanitor() {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of httpBuckets) {
      if (now - bucket.updatedAt > 600_000) httpBuckets.delete(ip);
    }
    for (const [ip, list] of recentByIp) {
      if (!pruneTimestamps(list, 60_000, now).length) recentByIp.delete(ip);
    }
  }, 120_000);
  timer.unref();
  return timer;
}

/** Números atuais, para o /health */
function snapshot() {
  return {
    ipsComConexao: openByIp.size,
    maiorPorIp,
    recusas: refused,
    limites: {
      totalMax: MAX_SOCKETS_TOTAL,
      porIp: MAX_SOCKETS_PER_IP,
      novasPorMinutoPorIp: NEW_PER_MINUTE_PER_IP
    }
  };
}

module.exports = {
  clientIp,
  BEHIND_PROXY,
  admit,
  release,
  createBudget,
  allow,
  cooldown,
  httpLimiter,
  startJanitor,
  snapshot,
  MAX_SOCKETS_TOTAL,
  MAX_SOCKETS_PER_IP
};
