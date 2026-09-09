/**
 * Perfil público do CHATMAROMBA: cidade, idade, uma frase e o Instagram.
 *
 * Tudo é opcional. Quem não preencher nada continua sendo só uma foto e um
 * apelido, e o cartão mostra exatamente isso — nada é inventado para
 * preencher espaço.
 *
 * Como o resto do chat, o perfil vive na memória e some quando a pessoa sai.
 */

const MAX_CIDADE = 32;
const MAX_FRASE = 90;
const IDADE_MIN = 18;   // as regras já exigem 18+; o perfil segue a mesma linha
const IDADE_MAX = 99;

/** Domínios que realmente são o Instagram */
const HOSTS_INSTAGRAM = new Set([
  'instagram.com',
  'www.instagram.com',
  'm.instagram.com',
  'instagr.am',
  'www.instagr.am'
]);

/** Caminhos do Instagram que não são perfil de gente */
const CAMINHOS_RESERVADOS = new Set([
  'p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'direct',
  'tv', 'about', 'developer', 'legal', 'privacy', 'terms'
]);

function limpar(texto, maximo) {
  return String(texto == null ? '' : texto)
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximo);
}

function cidade(valor) {
  // sem link e sem sinal de marcação escondido no nome da cidade
  return limpar(valor, MAX_CIDADE).replace(/[<>@]/g, '');
}

function idade(valor) {
  const n = Math.trunc(Number(valor));
  if (!Number.isFinite(n) || n < IDADE_MIN || n > IDADE_MAX) return null;
  return n;
}

/**
 * A frase é o único texto livre do perfil, então é onde o spam tentaria
 * entrar. Link ali é removido: quem quiser divulgar tem o campo do
 * Instagram, que passa por conferência de verdade.
 */
function frase(valor) {
  return limpar(valor, MAX_FRASE)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\b(?:www\.)?[a-z0-9-]+\.(?:com|net|org|br|io|me|gg|xyz|shop|link|site)\b\S*/gi, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Confere se é mesmo um perfil do Instagram.
 *
 * Aceita "@fulano", "fulano", "instagram.com/fulano" e o endereço completo
 * com ou sem parâmetros. Recusa qualquer outro site — e o cuidado principal
 * é não cair no truque de "instagram.com.site-falso.com" ou
 * "site-falso.com/instagram.com/fulano". Por isso o endereço é interpretado
 * de verdade e o domínio é comparado inteiro, nunca com "contém".
 *
 * Devolve { ok, url, handle } ou { ok: false, motivo }.
 */
function instagram(valor) {
  const bruto = limpar(valor, 120);
  if (!bruto) return { ok: true, url: null, handle: null };   // apagar é permitido

  let apelido = null;

  /**
   * Apelido do Instagram pode ter ponto ("joao.silva"), então não dá para
   * decidir olhando só se tem ponto. O que separa os dois casos é se o
   * começo é um domínio do Instagram ou se existe barra de caminho.
   */
  const semProtocolo = bruto.replace(/^https?:\/\//i, '');
  const inicio = semProtocolo.split('/')[0].toLowerCase();
  const pareceEndereco = /^https?:\/\//i.test(bruto)
    || HOSTS_INSTAGRAM.has(inicio)
    || semProtocolo.includes('/');

  if (!pareceEndereco && /^@?[A-Za-z0-9._]{1,30}$/.test(bruto)) {
    apelido = bruto.replace(/^@/, '');
  } else {
    let endereco;
    try {
      endereco = new URL(/^https?:\/\//i.test(bruto) ? bruto : 'https://' + bruto);
    } catch (e) {
      return { ok: false, motivo: 'Não entendi esse link do Instagram.' };
    }

    if (!HOSTS_INSTAGRAM.has(endereco.hostname.toLowerCase())) {
      return { ok: false, motivo: 'Esse link não é do Instagram.' };
    }

    const partes = endereco.pathname.split('/').filter(Boolean);
    if (!partes.length) return { ok: false, motivo: 'Falta o nome do perfil no link.' };
    if (CAMINHOS_RESERVADOS.has(partes[0].toLowerCase())) {
      return { ok: false, motivo: 'Use o link do perfil, não de uma publicação.' };
    }
    apelido = partes[0];
  }

  if (!/^[A-Za-z0-9._]{1,30}$/.test(apelido)) {
    return { ok: false, motivo: 'Nome de perfil do Instagram inválido.' };
  }
  if (apelido.startsWith('.') || apelido.endsWith('.') || apelido.includes('..')) {
    return { ok: false, motivo: 'Nome de perfil do Instagram inválido.' };
  }

  return { ok: true, url: 'https://instagram.com/' + apelido, handle: apelido };
}

/**
 * Monta o perfil a partir do que o cliente mandou.
 * Devolve { ok, perfil } ou { ok: false, motivo } — um campo errado não
 * derruba os outros, só o Instagram é bloqueante, porque é o único que
 * pode virar link.
 */
function montar(payload = {}) {
  const insta = instagram(payload.instagram);
  if (!insta.ok) return { ok: false, motivo: insta.motivo };

  return {
    ok: true,
    perfil: {
      cidade: cidade(payload.cidade) || null,
      idade: idade(payload.idade),
      frase: frase(payload.frase) || null,
      instagram: insta.url,
      instagramHandle: insta.handle
    }
  };
}

/** true se a pessoa preencheu ao menos alguma coisa */
function temAlgo(perfil) {
  if (!perfil) return false;
  return Boolean(perfil.cidade || perfil.idade || perfil.frase || perfil.instagram);
}

function vazio() {
  return { cidade: null, idade: null, frase: null, instagram: null, instagramHandle: null };
}

module.exports = {
  montar, vazio, temAlgo, instagram, cidade, idade, frase,
  MAX_CIDADE, MAX_FRASE, IDADE_MIN, IDADE_MAX
};
