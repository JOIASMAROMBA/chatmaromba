/**
 * Assuntos do momento.
 *
 * Conta as palavras que aparecem nas mensagens numa janela deslizante e
 * devolve as mais faladas, junto da sala onde cada uma está bombando.
 *
 * Três decisões que definem se isso presta:
 *
 * 1. Palavra precisa de gente DIFERENTE falando. Sem isso, uma pessoa
 *    repetindo "creatina" trinta vezes define o assunto do site inteiro —
 *    e vira ferramenta de divulgação de graça.
 *
 * 2. Janela deslizante em baldes de um minuto. "Do momento" tem que
 *    significar agora, não o acumulado do dia.
 *
 * 3. Lista de palavras vazias em português. Sem ela, o top 5 seria
 *    "que", "não", "para", "uma", "com" — verdadeiro e inútil.
 */

const JANELA_MIN = 15;          // minutos considerados "o momento"
const MAX_TERMOS_BALDE = 400;   // teto de memória por minuto
const MIN_PESSOAS = 2;          // pessoas distintas para a palavra valer
const MIN_LETRAS = 3;
const MAX_TERMOS_MSG = 6;       // palavras aproveitadas por mensagem

/** Palavras que aparecem em tudo e não dizem nada sobre o assunto */
const VAZIAS = new Set([
  'que', 'nao', 'com', 'uma', 'para', 'por', 'mas', 'como', 'mais', 'dos', 'das',
  'meu', 'minha', 'seu', 'sua', 'ele', 'ela', 'eles', 'elas', 'isso', 'isto',
  'aqui', 'ali', 'tem', 'ter', 'tenho', 'tinha', 'ser', 'sou', 'sao', 'era',
  'esta', 'estou', 'estava', 'foi', 'vai', 'vou', 'vamos', 'fazer', 'faz',
  'fiz', 'pode', 'posso', 'quer', 'quero', 'sabe', 'sei', 'acho', 'aco',
  'muito', 'pouco', 'bem', 'mal', 'agora', 'depois', 'antes', 'hoje', 'ontem',
  'amanha', 'sempre', 'nunca', 'tudo', 'nada', 'algo', 'alguem', 'ninguem',
  'gente', 'cara', 'mano', 'irmao', 'brother', 'kkk', 'kkkk', 'kkkkk', 'rsrs',
  'sim', 'nem', 'ate', 'so', 'ja', 'la', 'ai', 'ah', 'eh', 'ne', 'pra', 'pro',
  'pois', 'porque', 'quando', 'onde', 'qual', 'quem', 'entao', 'tambem',
  'ainda', 'mesmo', 'assim', 'todo', 'toda', 'todos', 'todas', 'outro', 'outra',
  'bom', 'boa', 'legal', 'top', 'blz', 'vlw', 'obrigado', 'obrigada', 'valeu',
  'oi', 'ola', 'opa', 'salve', 'fala', 'falou', 'bora', 'vamo', 'cade',
  'ver', 'vi', 'olha', 'deu', 'dar', 'ficar', 'fica', 'ficou', 'coisa',
  'dia', 'noite', 'tarde', 'manha', 'hora', 'vez', 'vezes', 'ano', 'mes',
  'sobre', 'entre', 'sem', 'seja', 'esse', 'essa', 'este', 'aquele', 'aquela',
  'voce', 'voces', 'nos', 'eu', 'te', 'me', 'se', 'lhe', 'ele', 'del',
  'aqui', 'chat', 'sala', 'galera', 'pessoal', 'alguma', 'algum', 'qualquer'
]);

/** balde de 1 minuto: termo -> { salas: Map<sala, n>, pessoas: Set } */
const baldes = [];
let minutoAtual = -1;

function normalizar(texto) {
  return String(texto)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/** Palavras aproveitáveis de uma mensagem, sem repetir */
function extrair(texto) {
  const limpo = normalizar(texto).replace(/https?:\/\/\S+/g, ' ');
  const cruas = limpo.split(/[^a-z0-9]+/);
  const vistas = new Set();

  for (const palavra of cruas) {
    if (vistas.size >= MAX_TERMOS_MSG) break;
    if (palavra.length < MIN_LETRAS || palavra.length > 20) continue;
    if (VAZIAS.has(palavra)) continue;
    if (/^\d+$/.test(palavra)) continue;
    // "aaaa", "hahaha" e afins não são assunto
    if (/^(.)\1+$/.test(palavra)) continue;
    vistas.add(palavra);
  }
  return [...vistas];
}

function baldeDeAgora() {
  const minuto = Math.floor(Date.now() / 60_000);
  if (minuto !== minutoAtual) {
    minutoAtual = minuto;
    baldes.push({ minuto, termos: new Map() });
    while (baldes.length > JANELA_MIN) baldes.shift();
  }
  return baldes[baldes.length - 1];
}

/**
 * Registra uma mensagem.
 * `salaBase` é o tema sem a divisão ("tema:treta", não "tema:treta~2"),
 * senão o mesmo assunto apareceria fatiado entre Sala 1, 2 e 3.
 */
function registrar(texto, salaBase, pessoaId) {
  const balde = baldeDeAgora();
  const termos = extrair(texto);

  for (const termo of termos) {
    let entrada = balde.termos.get(termo);
    if (!entrada) {
      if (balde.termos.size >= MAX_TERMOS_BALDE) continue;
      entrada = { salas: new Map(), pessoas: new Set() };
      balde.termos.set(termo, entrada);
    }
    entrada.salas.set(salaBase, (entrada.salas.get(salaBase) || 0) + 1);
    entrada.pessoas.add(pessoaId);
  }
}

/**
 * Ranking atual. Devolve no máximo `quantos` assuntos, cada um com a sala
 * em que mais se fala dele agora.
 */
function ranking(quantos = 5) {
  const limite = Math.floor(Date.now() / 60_000) - JANELA_MIN;
  const juntos = new Map();

  for (const balde of baldes) {
    if (balde.minuto < limite) continue;
    for (const [termo, entrada] of balde.termos) {
      let acumulado = juntos.get(termo);
      if (!acumulado) {
        acumulado = { total: 0, salas: new Map(), pessoas: new Set() };
        juntos.set(termo, acumulado);
      }
      for (const [sala, n] of entrada.salas) {
        acumulado.total += n;
        acumulado.salas.set(sala, (acumulado.salas.get(sala) || 0) + n);
      }
      for (const pessoa of entrada.pessoas) acumulado.pessoas.add(pessoa);
    }
  }

  return [...juntos.entries()]
    // a trava contra quem quer pautar o chat sozinho
    .filter(([, dados]) => dados.pessoas.size >= MIN_PESSOAS)
    .map(([termo, dados]) => {
      let salaTop = null;
      let maior = 0;
      for (const [sala, n] of dados.salas) {
        if (n > maior) { maior = n; salaTop = sala; }
      }
      return { termo, total: dados.total, pessoas: dados.pessoas.size, sala: salaTop };
    })
    .sort((a, b) => (b.pessoas - a.pessoas) || (b.total - a.total))
    .slice(0, quantos);
}

/** Zera tudo — usado nos testes */
function limpar() {
  baldes.length = 0;
  minutoAtual = -1;
}

module.exports = { registrar, ranking, extrair, limpar, MIN_PESSOAS, JANELA_MIN };
