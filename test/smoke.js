const { io } = require('socket.io-client');
const URL = process.env.CHAT_URL || 'http://localhost:' + (process.env.PORT || 3000);
const MOD_PASS = process.env.MOD_PASSWORD || 'senha-de-teste';
let TERMS_VERSAO = '';

/**
 * Sufixo único por execução.
 *
 * Sem ele, uma rodada do teste disputava apelido com a anterior: o
 * apelido é exclusivo enquanto a pessoa está online, então duas execuções
 * próximas derrubavam uma à outra por motivo nenhum — e o erro aparecia
 * como se o login estivesse quebrado.
 */
const SUF = Math.random().toString(36).slice(2, 6);
const N = (base) => base + SUF;

let tokenSeq = 0;

/** cada cliente tem seu token, como um navegador diferente teria */
function connect() {
  tokenSeq += 1;
  const token = 'token-de-teste-' + tokenSeq + '-' + Date.now();
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'], auth: { token } });
    s.on('connect', () => resolve(s));
  });
}

function login(s, nick, avatar) {
  return new Promise((resolve) => s.emit('login', { nick, avatar, terms: TERMS_VERSAO }, resolve));
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
  const regras = await fetch(URL + '/api/terms').then((r) => r.json());
  TERMS_VERSAO = regras.versao;
  check('GET /api/terms', Boolean(regras.versao && regras.secoes.length >= 4),
    'versão ' + regras.versao + ', ' + regras.secoes.length + ' seções');

  const rooms = await fetch(URL + '/api/rooms').then((r) => r.json());
  check('GET /api/rooms', rooms.themes.length === 6 && rooms.states.length === 27,
    'temas=' + rooms.themes.length + ' estados=' + rooms.states.length);

  const html = await fetch(URL + '/').then((r) => r.text());
  check('index.html servido', html.includes('CHATMAROMBA'));

  const css = await fetch(URL + '/css/style.css');
  const js = await fetch(URL + '/js/app.js');
  const sio = await fetch(URL + '/socket.io/socket.io.js');
  check('estáticos (css/js/socket.io)', css.ok && js.ok && sio.ok);

  /**
   * O navegador precisa perguntar antes de reusar o script. Com cache longo,
   * a pessoa fica rodando código antigo depois de um deploy e a tela para de
   * responder sem erro nenhum — foi exatamente o que aconteceu com o botão
   * de editar perfil.
   */
  const cacheJs = js.headers.get('cache-control') || '';
  check('script revalida a cada visita',
    /no-cache|no-store|max-age=0/.test(cacheJs), cacheJs || '(sem cache-control)');

  /**
   * Todo elemento que o script procura tem que existir na página. Quando um
   * não existe, o clique simplesmente não faz nada — o tipo de defeito mais
   * difícil de perceber, porque não quebra o resto.
   */
  const paginaHtml = await fetch(URL + '/').then((r) => r.text());
  const script = await fetch(URL + '/js/app.js').then((r) => r.text());
  const procurados = [...new Set([...script.matchAll(/\$\('#([a-zA-Z0-9_-]+)'\)/g)].map((m) => m[1]))];
  const existentes = new Set([...paginaHtml.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]));
  const ausentes = procurados.filter((id) => !existentes.has(id));
  check('página tem todos os elementos que o script usa',
    ausentes.length === 0, ausentes.length ? 'faltando: ' + ausentes.join(', ') : procurados.length + ' conferidos');

  /**
   * Atributo HTML sem aspas dentro do script.
   *
   * Existe porque um data-room ficou escrito como `data-room= + valor + `,
   * virando texto literal em vez de receber o id. O botão continuava
   * bonito na tela e simplesmente não levava a lugar nenhum.
   */
  const semAspas = script.split('\n')
    .map((linha, i) => ({ n: i + 1, linha: linha.trim() }))
    .filter(({ linha }) =>
      /(class|data-[a-z-]+|src|href|style|type|alt)=[a-zA-Z0-9$]/.test(linha) && linha.includes("'"));
  check('atributos HTML do script estão entre aspas',
    semAspas.length === 0,
    semAspas.length ? 'linha ' + semAspas[0].n + ': ' + semAspas[0].linha.slice(0, 70) : 'ok');

  /**
   * Nenhum campo de digitação pode ter fonte menor que 16px.
   *
   * Abaixo disso o Safari do iPhone dá zoom ao tocar no campo, e o que
   * estava na borda da tela — o botão de enviar — some da área visível.
   * Parece "a tela desconfigurou ao começar a escrever", e não é: é zoom.
   */
  const folha = await fetch(URL + '/css/style.css').then((r) => r.text());
  const camposPequenos = [...folha.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, seletor, corpo]) => {
      if (!/input|textarea|select/.test(seletor)) return false;
      const tamanho = corpo.match(/font-size:\s*([\d.]+)px/);
      return tamanho && Number(tamanho[1]) < 16;
    })
    .map(([, seletor]) => seletor.trim().replace(/\s+/g, ' '));
  check('campos de digitação com 16px ou mais (sem zoom no iPhone)',
    camposPequenos.length === 0,
    camposPequenos.length ? camposPequenos.join(' | ') : 'ok');

  /** o teclado do celular precisa redimensionar a página, não cobri-la */
  check('viewport preparado para o teclado do celular',
    /interactive-widget=resizes-content/.test(paginaHtml),
    /viewport/.test(paginaHtml) ? 'presente' : 'sem meta viewport');

  /**
   * Depois de entrar, a pessoa escolhe a sala — ninguém é jogado no Geral.
   *
   * Cair direto numa sala tira da pessoa a única decisão que importa na
   * chegada, e quem queria a sala do próprio estado já entrou no lugar
   * errado antes de ver a lista.
   */
  check('ninguém entra em sala automaticamente ao logar',
    !/joinRoom\((['"])tema:/.test(script),
    /joinRoom\((['"])tema:/.test(script) ? 'ainda entra sozinho' : 'ok');

  /**
   * O saguão é a primeira tela depois do apelido: a lista de salas com a
   * contagem de gente em cada uma. Se ele não desenhar, a pessoa cai numa
   * área vazia sem saber para onde ir.
   */
  check('a página tem o saguão de salas',
    /id="lobby-list"/.test(paginaHtml) && /id="lobby"/.test(paginaHtml));
  check('cada sala do saguão leva a um destino e mostra a contagem',
    script.includes('class="lobby-card" data-room="')
      && script.includes('data-count-for="') && script.includes('lobby-count'),
    script.includes('lobby-card') ? 'presente' : 'sem cartões');

  /** o top 5 precisa levar para a sala — sem isso ele é só enfeite */
  check('itens do ranking carregam a sala de destino',
    /data-room="'\s*\+\s*escapeHtml\(item\.salaId\)/.test(script),
    /data-room/.test(script) ? 'presente' : 'sem data-room');

  // ---------------------------------------------------------------- salas
  const a = await client(N('Monstro'));
  const b = await client(N('Frango'));
  check('login', a.me.nick === N('Monstro') && b.me.nick === N('Frango'));

  const ja = await join(a.s, 'tema:venenos');
  const jb = await join(b.s, 'tema:venenos');
  check('join sala de tema', ja.ok && jb.ok && ja.room.name === 'Venenos', ja.room && ja.room.name);

  const bad = await join(a.s, 'tema:naoexiste');
  check('sala inválida rejeitada', bad.ok === false);
  await join(a.s, 'tema:venenos');

  const gotMessage = new Promise((resolve) => {
    b.s.on('messages', (list) => {
      const chat = list.find((m) => m.type === 'chat');
      if (chat) resolve(chat);
    });
  });
  a.s.emit('message', { text: 'bora treinar <script>alert(1)</script>' });
  const msg = await gotMessage;
  check('mensagem entregue em tempo real', msg.text.includes('bora treinar') && msg.nick === N('Monstro'));

  // quem entra recebe a lista completa; quem já estava recebe só o delta
  const gotDelta = new Promise((resolve) => b.s.on('member-joined', resolve));
  const cSock = await connect();
  await login(cSock, N('Veterano'));
  const snapshot = await new Promise((resolve) => {
    cSock.once('members', resolve);
    cSock.emit('join', { roomId: 'tema:venenos' }, () => {});
  });
  const c = { s: cSock };
  check('quem entra recebe a lista completa',
    snapshot.members.length >= 2 && snapshot.total >= 2, 'n=' + snapshot.members.length);

  const delta = await gotDelta;
  check('quem já estava recebe só o delta',
    delta.member && delta.member.nick === N('Veterano') && typeof delta.total === 'number',
    'total=' + (delta && delta.total));

  const uf = await join(c.s, 'uf:SP');
  check('sala geral de estado', uf.ok && uf.room.name.includes('Geral'), uf.room && uf.room.name);
  const cidade = await join(c.s, 'cidade:SP:sao-jose-dos-campos');
  check('sala de cidade', cidade.ok && cidade.room.name === 'São José dos Campos / SP', cidade.room && cidade.room.name);

  const hist = await join(c.s, 'tema:venenos');
  check('histórico da sala', hist.history.some((m) => m.type === 'chat' && m.text.includes('bora treinar')),
    'msgs=' + hist.history.length);

  // ---------------------------------------------------------------- regras de uso
  // A trava tem que estar no servidor. Se estivesse só na tela, bastaria
  // falar direto com o socket, como este teste faz, para pular tudo.
  const semAceite = await connect();
  const loginSemAceite = await new Promise((r) =>
    semAceite.emit('login', { nick: N('SemRegras') }, r));
  check('login funciona sem aceitar', loginSemAceite.ok === true);

  const entradaBarrada = await join(semAceite, 'tema:geral');
  check('sem aceitar as regras não entra em sala',
    entradaBarrada.ok === false && entradaBarrada.error === 'terms', entradaBarrada.message);

  const versaoErrada = await new Promise((r) =>
    semAceite.emit('login', { nick: N('SemRegras'), terms: 'versao-inventada' }, r));
  const aindaBarrado = await join(semAceite, 'tema:geral');
  check('aceite de versão errada não vale',
    versaoErrada.ok === true && aindaBarrado.ok === false && aindaBarrado.error === 'terms');

  await new Promise((r) => semAceite.emit('login', { nick: N('SemRegras'), terms: TERMS_VERSAO }, r));
  const liberado = await join(semAceite, 'tema:geral');
  check('com o aceite certo, entra', liberado.ok === true, liberado.room && liberado.room.name);
  semAceite.close();

  // ---------------------------------------------------------------- apelido exclusivo
  const intruso = await connect();

  const dup = await login(intruso, N('Monstro'));
  check('apelido em uso é recusado', dup.ok === false && dup.error === 'nick-taken', dup.message);

  const dupCase = await login(intruso, N('MONSTRO'));
  check('bloqueio ignora maiúscula', dupCase.ok === false && dupCase.error === 'nick-taken');

  const dupAccent = await login(intruso, N('Mónstro') + ' ');
  check('bloqueio ignora acento e espaço', dupAccent.ok === false && dupAccent.error === 'nick-taken');

  const short = await login(intruso, 'x');
  check('apelido curto recusado', short.ok === false && short.error === 'nick-invalid');

  const busy = await checkNick(intruso, N('Monstro'));
  const freeNow = await checkNick(intruso, N('ApelidoQueNinguem'));
  check('check-nick', busy.available === false && freeNow.available === true);

  const okLogin = await login(intruso, N('Monstro2'));
  check('apelido livre é aceito', okLogin.ok === true && okLogin.me.nick === N('Monstro2'));

  // trocar de apelido devolve o antigo para o pool
  await login(intruso, N('Monstro3'));
  const reuseOld = await checkNick(a.s, N('Monstro2'));
  check('trocar de nome libera o antigo', reuseOld.available === true);

  // manter o próprio apelido não conflita consigo mesmo
  const keepOwn = await login(intruso, N('Monstro3'));
  check('reenviar o próprio apelido funciona', keepOwn.ok === true);

  // sair libera o apelido
  intruso.close();
  await wait(300);
  const afterLeave = await checkNick(a.s, N('Monstro3'));
  check('apelido volta a ficar livre ao sair', afterLeave.available === true);

  const herdeiro = await client(N('Monstro3'));
  check('outra pessoa assume o apelido liberado', herdeiro.res.ok === true && herdeiro.me.nick === N('Monstro3'));
  herdeiro.s.close();

  // troca de nome dentro da sala vira aviso do sistema
  const renameNotice = new Promise((resolve) => {
    b.s.on('messages', (list) => {
      const found = list.find((m) => m.type === 'system' && m.text.includes('agora é'));
      if (found) resolve(found);
    });
  });
  await login(a.s, N('MonstroPro'));
  const notice = await Promise.race([renameNotice, wait(800)]);
  check('sala avisa a troca de apelido', Boolean(notice && notice.text), notice && notice.text);

  // ---------------------------------------------------------------- foto de perfil
  // JPEG mínimo válido, montado à mão: começa com FFD8FF e termina com FFD9
  const jpegFalso = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from('CHATMAROMBA teste de foto'),
    Buffer.from([0xff, 0xd9])
  ]);

  const tokenFoto = 'token-da-foto-' + Date.now();
  const subir = (corpo, token) => fetch(URL + '/api/avatar', {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg', 'X-Device-Token': token || tokenFoto },
    body: corpo
  });

  /**
   * A política de conteúdo precisa permitir blob: em img-src, senão o
   * navegador nem consegue abrir a foto que a pessoa escolheu para cortar.
   * Este teste existe porque essa exata combinação já quebrou o envio de
   * foto em produção: o recurso estava certo, a configuração é que barrava.
   */
  const politica = (await fetch(URL + '/')).headers.get('content-security-policy') || '';
  const imgSrc = (politica.split(';').find((p) => p.trim().startsWith('img-src')) || '').trim();
  check('política permite o navegador abrir a foto escolhida',
    imgSrc.includes('blob:'), imgSrc || 'sem img-src');

  const envio = await subir(jpegFalso);
  const envioJson = await envio.json().catch(() => ({}));
  check('envio de foto aceito', envio.ok && envioJson.ok && envioJson.id, 'id=' + envioJson.id);

  const baixar = await fetch(URL + '/avatar/' + envioJson.id);
  check('foto servida com o tipo travado',
    baixar.ok && baixar.headers.get('content-type') === 'image/jpeg'
      && baixar.headers.get('x-content-type-options') === 'nosniff',
    baixar.headers.get('content-type'));

  const naoImagem = await subir(Buffer.from('<script>alert(1)</script>'));
  check('arquivo que não é imagem é recusado', naoImagem.status === 400);

  const gigante = await subir(Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(200 * 1024, 0x41), Buffer.from([0xff, 0xd9])
  ]));
  check('foto acima do limite é recusada', gigante.status === 400 || gigante.status === 413,
    'HTTP ' + gigante.status);

  // vestir a foto: só o dono do token consegue
  const dono = await connect();
  await new Promise((r) => dono.emit('login', { nick: N('DonoDaFoto'), terms: TERMS_VERSAO }, r));
  const alheia = await new Promise((r) => dono.emit('set-photo', { id: envioJson.id }, r));
  check('não dá para vestir a foto de outra pessoa', alheia.ok === false, alheia.message);
  dono.close();

  const eu = await new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'], auth: { token: tokenFoto } });
    s.on('connect', () => resolve(s));
  });
  await new Promise((r) => eu.emit('login', { nick: N('ComFoto'), terms: TERMS_VERSAO }, r));
  const minha = await new Promise((r) => eu.emit('set-photo', { id: envioJson.id }, r));
  check('o dono veste a própria foto', minha.ok === true && minha.photo === envioJson.id);

  await new Promise((r) => eu.emit('join', { roomId: 'tema:paquera' }, r));
  const comFoto = await new Promise((resolve) => {
    eu.on('messages', (list) => {
      const m = list.find((x) => x.type === 'chat' && x.photo);
      if (m) resolve(m);
    });
    eu.emit('message', { text: 'olha meu retrato' }, () => {});
  });
  check('a mensagem carrega a foto', comFoto.photo === envioJson.id);

  // moderador apaga a foto
  const xerife = await client(N('XerifeDaFoto'));
  await new Promise((r) => xerife.s.emit('mod-login', { password: MOD_PASS }, r));
  const apagou = await new Promise((r) =>
    xerife.s.emit('mod-action', { action: 'photo', nick: N('ComFoto'), reason: 'foto imprópria' }, r));
  check('moderador apaga foto', apagou.ok === true, apagou.message);

  const sumiu = await fetch(URL + '/avatar/' + envioJson.id);
  check('foto apagada some do servidor', sumiu.status === 404, 'HTTP ' + sumiu.status);
  eu.close();
  xerife.s.close();

  // ---------------------------------------------------------------- perfil
  const perfilado = await client(N('Perfilado'));
  await join(perfilado.s, 'tema:paquera');
  const curioso = await client(N('Curioso'));
  await join(curioso.s, 'tema:paquera');

  const vazio = await new Promise((r) => curioso.s.emit('get-profile', { id: perfilado.me.id }, r));
  check('perfil em branco não inventa informação',
    vazio.ok && vazio.perfil.preenchido === false
      && !vazio.perfil.cidade && !vazio.perfil.idade && !vazio.perfil.instagram,
    'nick=' + vazio.perfil.nick);

  const salvo = await new Promise((r) => perfilado.s.emit('set-profile', {
    cidade: 'Belo Horizonte', idade: 29, frase: 'bulking eterno', instagram: '@monstro.bh'
  }, r));
  check('salva o perfil', salvo.ok === true && salvo.perfil.instagram === 'https://instagram.com/monstro.bh',
    salvo.perfil && salvo.perfil.instagram);

  const cheio = await new Promise((r) => curioso.s.emit('get-profile', { id: perfilado.me.id }, r));
  check('terceiro enxerga o perfil preenchido',
    cheio.perfil.cidade === 'Belo Horizonte' && cheio.perfil.idade === 29
      && cheio.perfil.preenchido === true);

  // link falso: o truque clássico é um domínio que só PARECE ser do Instagram
  const falso = await new Promise((r) => perfilado.s.emit('set-profile', {
    instagram: 'https://instagram.com.site-falso.com/eu'
  }, r));
  check('link que só parece do Instagram é recusado', falso.ok === false, falso.message);

  const outroSite = await new Promise((r) => perfilado.s.emit('set-profile', {
    instagram: 'https://site-falso.com/instagram.com/eu'
  }, r));
  check('link de outro site é recusado', outroSite.ok === false, outroSite.message);

  const idadeInvalida = await new Promise((r) => perfilado.s.emit('set-profile', { idade: 12 }, r));
  check('idade abaixo de 18 é descartada',
    idadeInvalida.ok === true && idadeInvalida.perfil.idade === null);

  const fraseComLink = await new Promise((r) => perfilado.s.emit('set-profile', {
    frase: 'segue meu site loja.com.br agora'
  }, r));
  check('link na frase é removido',
    fraseComLink.ok === true && !/loja\.com\.br/.test(fraseComLink.perfil.frase || ''),
    JSON.stringify(fraseComLink.perfil.frase));

  // moderador limpa o perfil
  const xerifePerfil = await client(N('XerifePerfil'));
  await new Promise((r) => xerifePerfil.s.emit('mod-login', { password: MOD_PASS }, r));
  await new Promise((r) => perfilado.s.emit('set-profile', { instagram: '@spam.aqui' }, r));
  const limpou = await new Promise((r) => xerifePerfil.s.emit('mod-action',
    { action: 'wipe-profile', nick: N('Perfilado'), reason: 'divulgação' }, r));
  check('moderador limpa o perfil', limpou.ok === true, limpou.message);

  const depoisDaLimpeza = await new Promise((r) =>
    curioso.s.emit('get-profile', { id: perfilado.me.id }, r));
  check('perfil limpo some para todo mundo',
    depoisDaLimpeza.perfil.preenchido === false && !depoisDaLimpeza.perfil.instagram);

  perfilado.s.close();
  const sumiu2 = await new Promise((r) => {
    setTimeout(() => curioso.s.emit('get-profile', { id: perfilado.me.id }, r), 300);
  });
  check('perfil de quem saiu não é servido', sumiu2.ok === false, sumiu2.message);
  curioso.s.close();
  xerifePerfil.s.close();

  // ---------------------------------------------------------------- assuntos do momento
  /**
   * A lógica do ranking é testada direto no módulo, não pelo placar do
   * servidor: a janela é de 15 minutos, então rodadas anteriores do teste
   * ainda estão lá disputando as 5 vagas. Testar pelo topo seria testar a
   * sorte no desempate, não a regra.
   */
  const motor = require(`${__dirname}/../shared/trending`);
  motor.limpar();

  motor.registrar(`whey isolado e barato`, `tema:treinodieta`, `p1`);
  motor.registrar(`comprei whey ontem`, `tema:treinodieta`, `p2`);
  motor.registrar(`whey no shake`, `tema:treta`, `p1`);
  motor.registrar(`stanozolol pesado`, `tema:venenos`, `p3`);
  motor.registrar(`spam spam spam spam`, `tema:treta`, `p4`);
  motor.registrar(`spam de novo`, `tema:treta`, `p4`);

  const rank = motor.ranking(5);
  const whey = rank.find((r) => r.termo === `whey`);
  check(`assunto com gente diferente entra no ranking`, Boolean(whey),
    rank.map((r) => r.termo).join(`, `) || `vazio`);
  check(`o ranking aponta a sala mais quente`,
    Boolean(whey) && whey.sala === `tema:treinodieta`, whey && whey.sala);
  check(`uma pessoa sozinha não pauta o chat`,
    !rank.some((r) => r.termo === `stanozolol` || r.termo === `spam`),
    rank.map((r) => r.termo).join(`, `));
  check(`palavra repetida na mesma mensagem conta uma vez`,
    motor.extrair(`creatina creatina creatina`).length === 1);
  check(`palavra vazia do português é descartada`,
    motor.extrair(`que nao para uma com mas`).length === 0,
    JSON.stringify(motor.extrair(`que nao para uma com mas`)));
  motor.limpar();

  // integração: o formato do que chega ao cliente, e a entrega ao vivo
  const falante1 = await client(`FalanteUm`);
  const falante2 = await client(`FalanteDois`);
  await join(falante1.s, `tema:treinodieta`);
  await join(falante2.s, `tema:treinodieta`);

  const promessaAoVivo = new Promise((resolve) => {
    falante2.s.once(`trending`, resolve);
    setTimeout(() => resolve(null), 14000);
  });

  const palavra = `assuntoteste` + Math.floor(Math.random() * 100000);
  await new Promise((r) => falante1.s.emit(`message`, { text: `falando de ` + palavra }, r));
  await new Promise((r) => falante2.s.emit(`message`, { text: palavra + ` demais` }, r));

  const trend = await fetch(URL + `/api/trending`).then((r) => r.json());
  const formatoOk = Array.isArray(trend.assuntos) && trend.assuntos.every((item) =>
    typeof item.termo === `string` && item.termo.length > 0
    && typeof item.salaId === `string` && item.salaId.startsWith(`tema:`)
    && typeof item.salaNome === `string` && item.salaNome.length > 0
    && typeof item.pessoas === `number` && item.pessoas >= 2);
  check(`GET /api/trending devolve assuntos bem formados`, formatoOk,
    trend.assuntos.length + ` assuntos`);

  const chegouAoVivo = await promessaAoVivo;
  check(`ranking chega ao vivo pelo socket`, Array.isArray(chegouAoVivo),
    Array.isArray(chegouAoVivo) ? chegouAoVivo.length + ` assuntos` : `não chegou em 14s`);

  falante1.s.close();
  falante2.s.close();

  // ---------------------------------------------------------------- anti-flood
  let flooded = false;
  a.s.on('warning', () => { flooded = true; });
  for (let i = 0; i < 20; i += 1) a.s.emit('message', { text: 'spam ' + i });
  await wait(600);
  check('anti-flood', flooded);

  // ---------------------------------------------------------------- moderação

  const modo = await client(N('Xerife'));
  await join(modo.s, 'tema:treta');

  const wrongPass = await new Promise((r) => modo.s.emit('mod-login', { password: 'errada' }, r));
  check('senha de moderador errada é recusada', wrongPass.ok === false, wrongPass.message);

  const modLogin = await new Promise((r) => modo.s.emit('mod-login', { password: MOD_PASS }, r));
  check('login de moderador', modLogin.ok === true, modLogin.message);

  const semPoder = await new Promise((r) =>
    b.s.emit('mod-action', { action: 'mute', nick: N('MonstroPro') }, r));
  check('usuário comum não modera', semPoder.ok === false, semPoder.message);

  // silenciar de verdade
  const arruaceiro = await client(N('Arruaceiro'));
  await join(arruaceiro.s, 'tema:treta');
  const muteRes = await new Promise((r) =>
    modo.s.emit('mod-action', { action: 'mute', nick: N('Arruaceiro'), minutes: 5, reason: 'treta demais' }, r));
  check('moderador silencia', muteRes.ok === true, muteRes.message);

  const blockedSend = await new Promise((r) => arruaceiro.s.emit('message', { text: 'oi' }, r));
  check('silenciado não consegue falar', blockedSend.ok === false && blockedSend.error === 'muted');

  const pardonRes = await new Promise((r) =>
    modo.s.emit('mod-action', { action: 'pardon', nick: N('Arruaceiro') }, r));
  check('moderador libera', pardonRes.ok === true, pardonRes.message);
  const afterPardon = await new Promise((r) => arruaceiro.s.emit('message', { text: 'voltei' }, r));
  check('liberado volta a falar', afterPardon.ok === true);

  // apagar mensagem
  const deleted = new Promise((resolve) => arruaceiro.s.on('message-deleted', resolve));
  await new Promise((r) => modo.s.emit('mod-action',
    { action: 'delete', messageId: afterPardon.id, roomId: 'tema:treta' }, r));
  const delEvent = await Promise.race([deleted, wait(800)]);
  check('moderador apaga mensagem', Boolean(delEvent && delEvent.id === afterPardon.id));

  // expulsar
  const kickWarn = new Promise((resolve) => arruaceiro.s.on('kicked', resolve));
  await new Promise((r) => modo.s.emit('mod-action', { action: 'kick', nick: N('Arruaceiro'), reason: 'tchau' }, r));
  check('moderador expulsa', Boolean(await Promise.race([kickWarn, wait(800)])));

  // denúncia chega ao moderador
  const gotReport = new Promise((resolve) => modo.s.on('report', resolve));
  b.s.emit('report', { messageId: 'x1', nick: N('MonstroPro'), text: 'mensagem feia' });
  const report = await Promise.race([gotReport, wait(800)]);
  check('denúncia chega ao moderador', Boolean(report && report.nick === N('MonstroPro')));

  // ---------------------------------------------------------------- filtro automático
  const spammer = await client(N('Spammer'));
  await join(spammer.s, 'tema:treinodieta');
  let autoMuted = null;
  for (let i = 0; i < 5; i += 1) {
    const r = await new Promise((r2) => spammer.s.emit('message', { text: 'COMPRA AQUI AMIGO' }, r2));
    if (r && r.error === 'auto-mute') { autoMuted = r; break; }
  }
  check('filtro silencia mensagem repetida', Boolean(autoMuted));

  const linkSpammer = await client(N('LinkSpam'));
  await join(linkSpammer.s, 'tema:treinodieta');
  const muitoLink = await new Promise((r) =>
    linkSpammer.s.emit('message', { text: 'http://a.com http://b.com http://c.com' }, r));
  check('filtro barra muro de links', muitoLink.ok === false && muitoLink.error === 'blocked');

  [modo, arruaceiro, spammer, linkSpammer].forEach((x) => { try { x.s.close(); } catch (e) {} });

  // ---------------------------------------------------------------- divisão de sala
  const capacity = Number(process.env.ROOM_CAPACITY || 250);
  if (capacity <= 5) {
    const lotacao = [];
    for (let i = 0; i < capacity + 1; i += 1) {
      const extra = await client('Lotacao' + i);
      const res = await join(extra.s, 'tema:natural');
      lotacao.push({ extra, res });
    }
    const ultimo = lotacao[lotacao.length - 1].res;
    check('sala cheia abre uma divisão nova',
      ultimo.room.shard === 2 && ultimo.room.name.includes('Sala 2'), ultimo.room.name);
    lotacao.forEach((x) => x.extra.s.close());
  }

  const stats = await fetch(URL + '/api/stats').then((r) => r.json());
  check('GET /api/stats', stats.online >= 3, JSON.stringify(stats.counts));

  [a, b, c].forEach((x) => x.s.close());
  console.log(results.join('\n'));
  const passed = results.filter((r) => r.startsWith('PASS')).length;
  console.log('\n' + passed + '/' + results.length + ' ok');
  process.exit(passed === results.length ? 0 : 1);
})();
