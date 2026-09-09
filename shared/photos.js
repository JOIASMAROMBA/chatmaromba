/**
 * Fotos de perfil do CHATMAROMBA.
 *
 * Regras que guiaram este arquivo:
 *
 * 1. A foto é encolhida NO NAVEGADOR antes de subir (128x128, JPEG). O que
 *    chega aqui já são uns 8 KB. Aceitar o arquivo original de 3 MB da câmera
 *    encheria a memória e a conta de banda sem nenhum ganho visível.
 *
 * 2. Nada vai para disco. A foto vive na memória e some quando o servidor
 *    reinicia — igual ao resto do chat. Como são fotos de pessoas reais,
 *    guardar menos é melhor, não pior.
 *
 * 3. O id é o hash do conteúdo. Duas pessoas com a mesma foto ocupam um
 *    espaço só, e o navegador pode cachear para sempre sem risco de mostrar
 *    a foto errada.
 *
 * 4. O que o usuário manda NUNCA define o tipo do arquivo servido. A gente
 *    confere os bytes mágicos e serve sempre como image/jpeg. É assim que se
 *    evita alguém subir um script disfarçado de foto.
 */

const crypto = require('crypto');

/** Depois de encolhida no navegador, nenhuma foto legítima passa disso */
const MAX_BYTES = Number(process.env.MAX_PHOTO_BYTES || 48 * 1024);
/** Teto de fotos guardadas; a mais velha sai quando enche */
const MAX_PHOTOS = Number(process.env.MAX_PHOTOS || 1500);

/** id -> { bytes, ownerKey, ts } */
const store = new Map();

let rejeitadas = 0;

/**
 * Confere se os bytes são mesmo de um JPEG.
 * JPEG começa com FF D8 FF e termina com FF D9.
 */
function isJpeg(bytes) {
  if (!bytes || bytes.length < 4) return false;
  const comecaCerto = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const terminaCerto = bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  return comecaCerto && terminaCerto;
}

/**
 * Guarda uma foto. Devolve { ok, id } ou { ok: false, error }.
 * `ownerKey` é a identidade de quem subiu, para o dono poder trocar depois
 * e para o moderador conseguir apagar.
 */
function save(bytes, ownerKey) {
  if (!bytes || !bytes.length) {
    rejeitadas += 1;
    return { ok: false, error: 'arquivo vazio' };
  }
  if (bytes.length > MAX_BYTES) {
    rejeitadas += 1;
    return { ok: false, error: 'foto grande demais' };
  }
  if (!isJpeg(bytes)) {
    rejeitadas += 1;
    return { ok: false, error: 'isso não é uma foto JPEG' };
  }

  const id = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 20);

  // já existe: só renova a data para não ser descartada tão cedo
  const existente = store.get(id);
  if (existente) {
    existente.ts = Date.now();
    return { ok: true, id };
  }

  store.set(id, { bytes, ownerKey, ts: Date.now() });
  descartarVelhas();
  return { ok: true, id };
}

/** Tira as mais antigas quando o teto estoura */
function descartarVelhas() {
  if (store.size <= MAX_PHOTOS) return;
  const porIdade = [...store.entries()].sort((a, b) => a[1].ts - b[1].ts);
  const sobrando = store.size - MAX_PHOTOS;
  for (let i = 0; i < sobrando; i += 1) store.delete(porIdade[i][0]);
}

function get(id) {
  return store.get(String(id || '')) || null;
}

function exists(id) {
  return store.has(String(id || ''));
}

/** Usado pelo moderador e pelo banimento */
function remove(id) {
  return store.delete(String(id || ''));
}

/** Confere se aquela identidade foi quem subiu a foto */
function ownedBy(id, ownerKey) {
  const found = store.get(String(id || ''));
  return Boolean(found) && found.ownerKey === ownerKey;
}

function snapshot() {
  let bytes = 0;
  for (const foto of store.values()) bytes += foto.bytes.length;
  return {
    guardadas: store.size,
    memoriaKB: Math.round(bytes / 1024),
    rejeitadas,
    limites: { maxBytes: MAX_BYTES, maxFotos: MAX_PHOTOS }
  };
}

module.exports = { save, get, exists, remove, ownedBy, isJpeg, snapshot, MAX_BYTES };
