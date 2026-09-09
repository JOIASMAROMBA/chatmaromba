/* =========================================================
   CHATMAROMBA — cliente
   ========================================================= */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const el = {
    gate: $('#gate'),
    gateForm: $('#gate-form'),
    gateOnline: $('#gate-online'),
    gateRooms: $('#gate-rooms'),
    nickInput: $('#nick-input'),
    nickStatus: $('#nick-status'),
    avatarGrid: $('#avatar-grid'),
    photoPreview: $('#photo-preview'),
    photoPick: $('#photo-pick'),
    photoClear: $('#photo-clear'),
    photoInput: $('#photo-input'),
    photoHint: $('#photo-hint'),
    emojiPick: $('#emoji-pick'),
    avatarPicker: $('#avatar-picker'),
    gateStats: $('#gate-stats'),
    termsStep: $('#terms-step'),
    termsBody: $('#terms-body'),
    termsCheck: $('#terms-check'),
    termsAge: $('#terms-age'),
    termsGo: $('#terms-go'),
    termsBack: $('#terms-back'),
    rulesLink: $('#rules-link'),
    rulesModal: $('#rules-modal'),
    rulesBody: $('#rules-body'),
    rulesClose: $('#rules-close'),
    cardModal: $('#card-modal'),
    cardVisita: $('#card-visita'),
    profileModal: $('#profile-modal'),
    profileForm: $('#profile-form'),
    profileClose: $('#profile-close'),
    profilePhotoBtn: $('#profile-photo-btn'),
    profNick: $('#prof-nick'),
    profCidade: $('#prof-cidade'),
    profIdade: $('#prof-idade'),
    profFrase: $('#prof-frase'),
    profInsta: $('#prof-insta'),
    profFraseConta: $('#prof-frase-conta'),
    profInstaAviso: $('#prof-insta-aviso'),
    profPreview: $('#prof-preview'),
    profEmojis: $('#prof-emojis'),

    app: $('#app'),
    sidebar: $('#sidebar'),
    scrim: $('#scrim'),
    openSidebar: $('#open-sidebar'),
    closeSidebar: $('#close-sidebar'),

    searchInput: $('#search-input'),
    themeList: $('#theme-list'),
    trendList: $('#trend-list'),
    trendEmpty: $('#trend-empty'),
    stateList: $('#state-list'),

    meAvatar: $('#me-avatar'),
    meNick: $('#me-nick'),
    editMe: $('#edit-me'),
    meCard: $('#me-card'),

    roomIcon: $('#room-icon'),
    roomName: $('#room-name'),
    roomTagline: $('#room-tagline'),
    roomOnline: $('#room-online'),

    messages: $('#messages'),
    emptyState: $('#empty-state'),
    typingBar: $('#typing-bar'),

    composer: $('#composer'),
    messageInput: $('#message-input'),
    sendBtn: $('#send-btn'),
    replyPreview: $('#reply-preview'),
    replyNick: $('#reply-nick'),
    replyText: $('#reply-text'),
    cancelReply: $('#cancel-reply'),

    membersPanel: $('#members-panel'),
    memberList: $('#member-list'),
    membersCount: $('#members-count'),
    toggleMembers: $('#toggle-members'),
    closeMembers: $('#close-members'),

    toast: $('#toast')
  };

  const state = {
    socket: null,
    me: null,
    avatars: [],
    avatar: null,
    photo: null,
    rooms: { themes: [], states: [] },
    terms: null,
    profile: null,
    roomIndex: new Map(),   // id -> { id, name, icon, tagline, kind }
    currentRoom: null,
    counts: {},
    replyTo: null,
    members: [],
    membersTotal: 0,
    isMod: false,
    mutedUntil: 0,
    banned: false,
    typingUsers: new Map(),
    typingSent: false,
    typingTimer: null,
    lastDay: null
  };

  // ------------------------------------------------------ utilidades

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** escapa e transforma links em <a> clicável */
  function renderText(text) {
    const safe = escapeHtml(text);
    return safe.replace(/(https?:\/\/[^\s<]+)/g, (url) =>
      '<a href="' + url + '" target="_blank" rel="noopener noreferrer nofollow">' + url + '</a>'
    );
  }

  function normalize(text) {
    return String(text).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  }

  function timeLabel(ts) {
    return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function dayLabel(ts) {
    const date = new Date(ts);
    const today = new Date();
    const isToday = date.toDateString() === today.toDateString();
    if (isToday) return 'Hoje';
    const yesterday = new Date(today.getTime() - 86400000);
    if (date.toDateString() === yesterday.toDateString()) return 'Ontem';
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' });
  }

  let toastTimer = null;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3200);
  }

  function countBadge(roomId) {
    const n = state.counts[roomId] || 0;
    return '<span class="room-count' + (n ? '' : ' is-zero') + '" data-count-for="' + roomId + '">' + n + '</span>';
  }

  // ------------------------------------------------------ regras de uso

  /**
   * Desenha as regras. O mesmo HTML serve para a tela de entrada e para a
   * janela de releitura dentro do chat — regra que só aparece uma vez, na
   * pressa de entrar, não é regra que alguém lembra.
   */
  function montarRegras(destino) {
    const t = state.terms;
    if (!t) { destino.innerHTML = '<p class="terms-intro">Carregando as regras...</p>'; return; }

    const secoes = t.secoes.map((secao) => {
      const itens = secao.itens.map((item) =>
        '<li><strong>' + escapeHtml(item.titulo) + '</strong>'
        + '<span>' + escapeHtml(item.texto) + '</span></li>'
      ).join('');

      return (
        '<section class="terms-section' + (secao.tom === 'grave' ? ' is-grave' : '') + '">'
        + '<h4><span class="terms-icon">' + secao.icone + '</span>' + escapeHtml(secao.titulo) + '</h4>'
        + '<ul>' + itens + '</ul>'
        + '</section>'
      );
    }).join('');

    destino.innerHTML =
      '<p class="terms-intro">' + escapeHtml(t.intro) + '</p>'
      + secoes
      + '<p class="terms-version">Versão ' + escapeHtml(t.versao) + '</p>';
  }

  /** true se a pessoa já aceitou exatamente esta versão das regras */
  function jaAceitou() {
    if (!state.terms) return false;
    try {
      return localStorage.getItem('cm_terms') === state.terms.versao;
    } catch (e) {
      return false;
    }
  }

  function guardarAceite() {
    try { localStorage.setItem('cm_terms', state.terms.versao); } catch (e) { /* ignore */ }
  }

  function mostrarPasso(qual) {
    const naRegra = qual === 'regras';
    el.gateForm.hidden = naRegra;
    el.termsStep.hidden = !naRegra;
    el.gateStats.hidden = naRegra;
    if (naRegra) {
      montarRegras(el.termsBody);
      el.termsCheck.checked = false;
      el.termsGo.disabled = true;
      el.termsBody.scrollTop = 0;
      el.termsBody.focus();
    }
  }

  el.termsCheck.addEventListener('change', () => {
    el.termsGo.disabled = !el.termsCheck.checked;
  });

  el.termsBack.addEventListener('click', () => mostrarPasso('apelido'));

  el.termsGo.addEventListener('click', () => {
    if (!el.termsCheck.checked) return;
    guardarAceite();
    entrarNoChat();
  });

  el.rulesLink.addEventListener('click', () => {
    montarRegras(el.rulesBody);
    el.rulesModal.hidden = false;
  });
  el.rulesClose.addEventListener('click', () => { el.rulesModal.hidden = true; });
  el.rulesModal.addEventListener('click', (event) => {
    if (event.target === el.rulesModal) el.rulesModal.hidden = true;
  });

  // ------------------------------------------------------ cartão de visita

  /**
   * Cartão que aparece ao clicar na foto de alguém.
   *
   * A regra que manda aqui: campo em branco não vira nada na tela. Nada de
   * "Cidade: não informada" — isso é ruído, e faz o cartão de quem não
   * preencheu parecer um formulário incompleto em vez de uma escolha.
   */
  function montarCartao(p) {
    const retrato = p.photo
      ? '<span class="card-foto has-photo"><img src="/avatar/' + encodeURIComponent(p.photo) + '" alt="" /></span>'
      : '<span class="card-foto">' + escapeHtml(p.avatar || '💪') + '</span>';

    const linhas = [];
    if (p.cidade) linhas.push('<li><span class="card-icone">📍</span>' + escapeHtml(p.cidade) + '</li>');
    if (p.idade) linhas.push('<li><span class="card-icone">🎂</span>' + escapeHtml(String(p.idade)) + ' anos</li>');
    if (p.instagram) {
      linhas.push(
        '<li><span class="card-icone">📸</span>'
        + '<a href="' + escapeHtml(p.instagram) + '" target="_blank" rel="noopener noreferrer nofollow">@'
        + escapeHtml(p.instagramHandle) + '</a></li>'
      );
    }

    // quem não preencheu nada tem direito a um cartão que não parece defeito
    const frase = p.frase
      ? escapeHtml(p.frase)
      : (p.preenchido ? '' : 'Ainda não contou nada por aqui.');

    return (
      '<button class="card-fechar" id="card-fechar" aria-label="Fechar">✕</button>'
      + '<div class="card-topo">'
      +   retrato
      +   '<div class="card-info">'
      +     '<h3 style="color:' + (p.color || '#fff') + '">' + escapeHtml(p.nick) + '</h3>'
      +     (p.mod ? '<span class="mod-badge">MOD</span>' : '')
      +     (frase ? '<p class="card-frase">' + frase + '</p>' : '')
      +     (linhas.length ? '<ul class="card-lista">' + linhas.join('') + '</ul>' : '')
      +   '</div>'
      + '</div>'
    );
  }

  function abrirCartao(socketId) {
    if (!socketId || !state.socket) return;
    state.socket.emit('get-profile', { id: socketId }, (res) => {
      if (!res || !res.ok) return toast(res && res.message ? res.message : 'Não consegui abrir o perfil.');
      el.cardVisita.innerHTML = montarCartao(res.perfil);
      el.cardModal.hidden = false;
      const fechar = document.getElementById('card-fechar');
      if (fechar) fechar.addEventListener('click', () => { el.cardModal.hidden = true; });
    });
  }

  el.cardModal.addEventListener('click', (event) => {
    if (event.target === el.cardModal) el.cardModal.hidden = true;
  });

  // ------------------------------------------------------ meu perfil

  function abrirEditorPerfil() {
    const p = state.profile || {};
    el.profNick.value = state.me ? state.me.nick : '';
    el.profCidade.value = p.cidade || '';
    el.profIdade.value = p.idade || '';
    el.profFrase.value = p.frase || '';
    el.profInsta.value = p.instagramHandle ? '@' + p.instagramHandle : '';
    el.profFraseConta.textContent = (el.profFrase.value.length) + '/90';
    el.profInstaAviso.textContent = 'Só aceita link ou @ do Instagram.';
    el.profInstaAviso.className = 'field-help';
    pintarPreviewPerfil();
    el.profileModal.hidden = false;
    el.profNick.focus();
  }

  /** o mesmo retrato da tela de entrada, agora dentro do editor */
  function pintarPreviewPerfil() {
    if (state.photo) {
      el.profPreview.innerHTML = '<img src="/avatar/' + state.photo + '" alt="" />';
      el.profPreview.classList.add('tem-conteudo');
    } else if (state.avatar) {
      el.profPreview.innerHTML = '<span class="retrato-emoji">' + escapeHtml(state.avatar) + '</span>';
      el.profPreview.classList.add('tem-conteudo');
    } else {
      el.profPreview.innerHTML = SILHUETA;
      el.profPreview.classList.remove('tem-conteudo');
    }

    if (!el.profEmojis.children.length) {
      el.profEmojis.innerHTML = state.avatars
        .map((e) => '<button type="button" class="avatar-opt" data-avatar="' + e + '">' + e + '</button>')
        .join('');
    }
    el.profEmojis.querySelectorAll('.avatar-opt').forEach((b) => {
      b.classList.toggle('is-active', !state.photo && b.dataset.avatar === state.avatar);
    });
  }

  el.profEmojis.addEventListener('click', (event) => {
    const btn = event.target.closest('.avatar-opt');
    if (!btn) return;
    state.avatar = btn.dataset.avatar;
    if (state.photo) {          // emoji e foto são excludentes
      state.photo = null;
      aplicarFoto(null);
    }
    pintarPreviewPerfil();
    mostrarRetrato();
  });

  el.profFrase.addEventListener('input', () => {
    el.profFraseConta.textContent = el.profFrase.value.length + '/90';
  });

  el.profileClose.addEventListener('click', () => { el.profileModal.hidden = true; });
  el.profileModal.addEventListener('click', (event) => {
    if (event.target === el.profileModal) el.profileModal.hidden = true;
  });

  el.profilePhotoBtn.addEventListener('click', () => el.photoInput.click());

  el.profileForm.addEventListener('submit', (event) => {
    event.preventDefault();

    const novoNick = el.profNick.value.trim();
    /**
     * O apelido e a cara viajam juntos no mesmo evento de login, então
     * salvar sempre reenvia os dois. Assim trocar só o emoji também vale,
     * sem precisar de um caminho separado.
     */
    const precisaLogin = state.me && novoNick
      && (novoNick !== state.me.nick || state.avatar !== state.me.avatar);

    const salvarPerfil = () => {
      state.socket.emit('set-profile', {
        cidade: el.profCidade.value,
        idade: el.profIdade.value,
        frase: el.profFrase.value,
        instagram: el.profInsta.value
      }, (res) => {
        if (!res || !res.ok) {
          el.profInstaAviso.textContent = res && res.message ? res.message : 'Não deu para salvar.';
          el.profInstaAviso.className = 'field-help is-erro';
          return;
        }
        state.profile = res.perfil;
        el.profileModal.hidden = true;
        toast('Perfil salvo.');
      });
    };

    if (precisaLogin) {
      const versaoRegras = state.terms ? state.terms.versao : '';
      state.socket.emit('login', {
        nick: novoNick, avatar: state.avatar || '👤', terms: versaoRegras
      }, (res) => {
        if (!res || !res.ok) {
          el.profInstaAviso.textContent = res && res.message ? res.message : 'Apelido indisponível.';
          el.profInstaAviso.className = 'field-help is-erro';
          return;
        }
        state.me = res.me;
        el.meNick.textContent = res.me.nick;
        pintarMeCard();
        salvarPerfil();
      });
    } else {
      salvarPerfil();
    }
  });

  /** reenvia o perfil ao servidor depois de entrar ou reconectar */
  function reenviarPerfil() {
    const p = state.profile;
    if (!p || !(p.cidade || p.idade || p.frase || p.instagram)) return;
    state.socket.emit('set-profile', {
      cidade: p.cidade, idade: p.idade, frase: p.frase,
      instagram: p.instagramHandle || p.instagram
    }, (res) => {
      if (res && res.ok) state.profile = res.perfil;
    });
  }

  // ------------------------------------------------------ foto de perfil

  /** lado do quadrado final. 128 é nítido no celular e continua leve */
  const PHOTO_SIZE = 128;
  const PHOTO_QUALITY = 0.82;

  /**
   * Encolhe a foto AQUI, no navegador, antes de subir.
   *
   * É o passo que torna a funcionalidade viável: a foto da câmera tem uns
   * 3 MB. Se ela subisse inteira, seriam 3 GB para mil pessoas, e o servidor
   * teria que reprocessar tudo. Cortada em 128x128 e comprimida, vira uns
   * 8 KB — e o navegador de quem vê ainda guarda em cache.
   *
   * O corte é quadrado e centralizado, que é como um retrato redondo espera.
   */
  /** desenha a imagem já cortada em quadrado e devolve o JPEG comprimido */
  function recortarQuadrado(fonte, largura, altura) {
    const lado = Math.min(largura, altura);
    const sx = (largura - lado) / 2;
    const sy = (altura - lado) / 2;

    const canvas = document.createElement('canvas');
    canvas.width = PHOTO_SIZE;
    canvas.height = PHOTO_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(fonte, sx, sy, lado, lado, 0, 0, PHOTO_SIZE, PHOTO_SIZE);

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Não consegui processar a imagem.'))),
        'image/jpeg',
        PHOTO_QUALITY
      );
    });
  }

  /** caminho antigo: abre a foto por uma URL temporária blob: */
  function lerComImagem(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        recortarQuadrado(img, img.width, img.height).then(resolve, reject);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Não consegui abrir essa imagem. Tenta salvar como JPG e enviar de novo.'));
      };
      img.src = url;
    });
  }

  async function encolherFoto(file) {
    if (!file.type.startsWith('image/')) throw new Error('Isso não é uma imagem.');
    if (file.size > 25 * 1024 * 1024) throw new Error('Imagem grande demais (máx. 25 MB).');

    /**
     * createImageBitmap decodifica o arquivo direto, sem precisar criar uma
     * URL blob: para o navegador carregar. Além de ser mais rápido, não
     * depende da política de conteúdo permitir blob: — e foi exatamente
     * isso que quebrou o envio de foto na primeira versão.
     */
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(file);
        const blob = await recortarQuadrado(bitmap, bitmap.width, bitmap.height);
        if (bitmap.close) bitmap.close();
        return blob;
      } catch (e) {
        // formato que o createImageBitmap não decodifica: tenta do jeito antigo
      }
    }
    return lerComImagem(file);
  }

  /** Sobe a foto já encolhida e devolve o id que o servidor deu */
  async function enviarFoto(blob) {
    const res = await fetch('/api/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', 'X-Device-Token': deviceToken() },
      body: blob
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'Não deu para enviar a foto.');
    return data.id;
  }

  /** silhueta: o estado "ainda não escolhi nada" */
  const SILHUETA = '<svg class="silhueta" viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M12 12.2a4.6 4.6 0 1 0 0-9.2 4.6 4.6 0 0 0 0 9.2Z"/>'
    + '<path d="M12 14.3c-4.6 0-8.3 2.4-8.3 5.3V22h16.6v-2.4c0-2.9-3.7-5.3-8.3-5.3Z"/></svg>';

  function mostrarRetrato() {
    if (state.photo) {
      el.photoPreview.innerHTML = '<img src="/avatar/' + state.photo + '" alt="Sua foto" />';
      el.photoPreview.classList.add('tem-conteudo');
    } else if (state.avatar) {
      el.photoPreview.innerHTML = '<span class="retrato-emoji">' + escapeHtml(state.avatar) + '</span>';
      el.photoPreview.classList.add('tem-conteudo');
    } else {
      el.photoPreview.innerHTML = SILHUETA;
      el.photoPreview.classList.remove('tem-conteudo');
    }
    el.photoClear.hidden = !state.photo && !state.avatar;
  }

  /** fecha o painel de emojis */
  function fecharEmojis() {
    el.avatarPicker.hidden = true;
    el.emojiPick.setAttribute('aria-expanded', 'false');
  }

  el.photoPick.addEventListener('click', () => el.photoInput.click());

  el.photoInput.addEventListener('change', async () => {
    const file = el.photoInput.files && el.photoInput.files[0];
    el.photoInput.value = '';                 // deixa reescolher a mesma foto
    if (!file) return;

    el.photoHint.textContent = 'Preparando a foto...';
    try {
      const blob = await encolherFoto(file);
      const id = await enviarFoto(blob);
      state.photo = id;
      state.avatar = null;
      fecharEmojis();
      mostrarRetrato();
      el.photoHint.textContent = 'Foto pronta (' + Math.round(blob.size / 1024) + ' KB).';
      if (state.me) aplicarFoto(id);
    } catch (err) {
      el.photoHint.textContent = err.message;
    }
  });

  el.photoClear.addEventListener('click', () => {
    state.photo = null;
    state.avatar = null;
    el.avatarGrid.querySelectorAll('.avatar-opt').forEach((b) => b.classList.remove('is-active'));
    mostrarRetrato();
    fecharEmojis();
    el.photoHint.textContent = 'Opcional. Sem foto, você entra como silhueta.';
    if (state.me) aplicarFoto(null);
  });

  /** avisa o servidor de qual retrato usar agora */
  function aplicarFoto(id) {
    state.socket.emit('set-photo', { id: id || '' }, (res) => {
      if (!res || !res.ok) return toast(res && res.message ? res.message : 'Não deu para trocar a foto.');
      if (state.me) state.me.photo = res.photo;
      pintarMeCard();
    });
  }

  /** o retrato do rodapé da barra lateral */
  function pintarMeCard() {
    const foto = state.me && state.me.photo;
    el.meAvatar.innerHTML = foto
      ? '<img src="/avatar/' + foto + '" alt="" />'
      : escapeHtml(state.me ? state.me.avatar : '💪');
  }

  /** o retrato que aparece em mensagem e na lista de membros */
  function retratoHtml(pessoa, classe) {
    if (pessoa.photo) {
      return '<span class="' + classe + ' has-photo"><img src="/avatar/'
        + encodeURIComponent(pessoa.photo) + '" alt="" loading="lazy" /></span>';
    }
    return '<span class="' + classe + '">' + escapeHtml(pessoa.avatar || '💪') + '</span>';
  }

  // ------------------------------------------------------ tela de entrada

  function renderAvatarPicker() {
    el.avatarGrid.innerHTML = state.avatars
      .map((emoji) =>
        '<button type="button" class="avatar-opt" data-avatar="' + emoji + '">' + emoji + '</button>'
      )
      .join('');
  }

  el.emojiPick.addEventListener('click', () => {
    const abrindo = el.avatarPicker.hidden;
    el.avatarPicker.hidden = !abrindo;
    el.emojiPick.setAttribute('aria-expanded', String(abrindo));
  });

  el.avatarGrid.addEventListener('click', (event) => {
    const btn = event.target.closest('.avatar-opt');
    if (!btn) return;

    el.avatarGrid.querySelectorAll('.avatar-opt').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    state.avatar = btn.dataset.avatar;

    if (state.photo) {   // emoji e foto são excludentes: um substitui o outro
      state.photo = null;
      if (state.me) aplicarFoto(null);
    }
    mostrarRetrato();
    fecharEmojis();
  });

  /** feedback do campo de apelido: livre / em uso / conferindo */
  function setNickStatus(kind, text) {
    el.nickStatus.textContent = text;
    el.nickStatus.className = 'nick-status' + (kind ? ' is-' + kind : '');
    el.nickInput.classList.toggle('is-taken', kind === 'taken');
    el.nickInput.classList.toggle('is-free', kind === 'free');
  }

  function rejectNick(message) {
    setNickStatus('taken', message);
    el.nickInput.classList.remove('shake');
    void el.nickInput.offsetWidth;          // reinicia a animação
    el.nickInput.classList.add('shake');
    el.nickInput.focus();
    el.nickInput.select();
  }

  /** tela cheia de bloqueio: banido ou expulso */
  function showBlocked(title, reason, until) {
    const quando = until
      ? 'Liberado em ' + new Date(until).toLocaleString('pt-BR') + '.'
      : 'Você pode voltar recarregando a página.';
    document.body.innerHTML =
      '<div class="blocked-screen">' +
        '<span class="blocked-icon">🚫</span>' +
        '<h1>' + escapeHtml(title) + '</h1>' +
        '<p class="blocked-reason">' + escapeHtml(reason || 'sem motivo declarado') + '</p>' +
        '<p class="blocked-when">' + escapeHtml(quando) + '</p>' +
      '</div>';
  }

  /** trava o campo enquanto o silêncio durar */
  function updateComposerLock() {
    const muted = state.mutedUntil > Date.now();
    el.messageInput.disabled = muted || !state.currentRoom;
    el.sendBtn.disabled = el.messageInput.disabled;
    if (muted) {
      const min = Math.ceil((state.mutedUntil - Date.now()) / 60000);
      el.messageInput.placeholder = 'Silenciado por mais ' + min + ' min';
      setTimeout(updateComposerLock, Math.min(60000, state.mutedUntil - Date.now() + 500));
    }
  }

  /** volta para a tela de entrada (apelido perdido, reconexão falhou) */
  function backToGate(message) {
    state.me = null;
    state.currentRoom = null;
    el.app.hidden = true;
    el.gate.classList.remove('is-out');
    el.gate.style.display = '';
    el.messageInput.disabled = true;
    el.sendBtn.disabled = true;
    rejectNick(message);
  }

  // consulta de disponibilidade enquanto a pessoa digita
  let nickCheckTimer = null;
  el.nickInput.addEventListener('input', () => {
    const nick = el.nickInput.value.trim();
    clearTimeout(nickCheckTimer);

    if (nick.length < 2) {
      setNickStatus('', 'Ninguém online pode repetir seu apelido.');
      return;
    }
    setNickStatus('checking', 'Conferindo se está livre...');
    nickCheckTimer = setTimeout(() => {
      if (!state.socket) return;
      state.socket.emit('check-nick', { nick }, (res) => {
        if (!res || el.nickInput.value.trim() !== nick) return;   // resposta velha, ignora
        if (res.available) setNickStatus('free', '"' + nick + '" está livre. Bora.');
        else setNickStatus('taken', '"' + nick + '" está online agora. Escolhe outro.');
      });
    }, 320);
  });

  el.gateForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const nick = el.nickInput.value.trim();
    if (nick.length < 2) {
      rejectNick('O apelido precisa de pelo menos 2 letras.');
      return;
    }
    /**
     * Confere o apelido ANTES de mandar ler as regras. Seria cruel fazer a
     * pessoa ler tudo, aceitar, e só então descobrir que o nome está em uso.
     */
    state.socket.emit('check-nick', { nick }, (res) => {
      if (res && res.available === false) {
        return rejectNick('"' + nick + '" está online agora. Escolhe outro.');
      }
      if (jaAceitou()) entrarNoChat();
      else mostrarPasso('regras');
    });
  });

  /** login de verdade, já com o aceite das regras */
  function entrarNoChat() {
    const nick = el.nickInput.value.trim();
    const versao = state.terms ? state.terms.versao : '';

    state.socket.emit('login', { nick, avatar: state.avatar || '👤', terms: versao }, (res) => {
      if (!res || !res.ok) {
        mostrarPasso('apelido');
        return rejectNick(res && res.message ? res.message : 'Não rolou entrar. Tenta de novo.');
      }
      state.me = res.me;
      el.meNick.textContent = res.me.nick;
      pintarMeCard();
      if (state.photo) aplicarFoto(state.photo);
      reenviarPerfil();

      el.gate.classList.add('is-out');
      setTimeout(() => { el.gate.style.display = 'none'; }, 380);
      el.app.hidden = false;
      if (window.innerWidth <= 780) setSidebar(true);
      // já abre no papo geral
      joinRoom('tema:geral');
    });
  }

  // ------------------------------------------------------ lista de salas

  function renderThemes(filter) {
    const query = normalize(filter || '');
    const items = state.rooms.themes.filter((t) =>
      !query || normalize(t.name).includes(query) || normalize(t.tagline).includes(query)
    );

    if (!items.length) {
      el.themeList.innerHTML = '<p class="no-result">Nenhum tema com esse nome.</p>';
      return;
    }

    el.themeList.innerHTML = items
      .map((t) => {
        const id = 'tema:' + t.id;
        const active = state.currentRoom === id ? ' is-active' : '';
        return (
          '<button class="room-item' + active + '" data-room="' + id + '">' +
            '<span class="room-item-icon" style="background:' + t.color + '22;border-color:' + t.color + '55">' + t.icon + '</span>' +
            '<span class="room-item-body">' +
              '<span class="room-item-name">' + escapeHtml(t.name) + '</span>' +
              '<span class="room-item-tag">' + escapeHtml(t.tagline) + '</span>' +
            '</span>' +
            countBadge(id) +
          '</button>'
        );
      })
      .join('');
  }

  function renderStates(filter) {
    const query = normalize(filter || '');

    const blocks = state.rooms.states
      .map((s) => {
        const stateHit = !query || normalize(s.name).includes(query) || normalize(s.uf).includes(query);
        const cities = s.cities.filter((c) => stateHit || normalize(c).includes(query));
        if (!stateHit && !cities.length) return '';

        const ufRoom = 'uf:' + s.uf;
        const open = query || isOpenState(s.uf) ? ' is-open' : '';

        const cityHtml = cities
          .map((c) => {
            const id = 'cidade:' + s.uf + ':' + slug(c);
            const active = state.currentRoom === id ? ' is-active' : '';
            return (
              '<button class="city-item' + active + '" data-room="' + id + '">' +
                '<span>🏙️</span><span class="member-nick">' + escapeHtml(c) + '</span>' + countBadge(id) +
              '</button>'
            );
          })
          .join('');

        const geralActive = state.currentRoom === ufRoom ? ' is-active' : '';

        return (
          '<div class="state-block' + open + '" data-uf="' + s.uf + '">' +
            '<button class="state-head" data-toggle="' + s.uf + '">' +
              '<span class="uf-badge">' + s.uf + '</span>' +
              '<span class="state-name">' + escapeHtml(s.name) + '</span>' +
              countBadge(ufRoom) +
              '<span class="state-caret">▶</span>' +
            '</button>' +
            '<div class="city-list">' +
              '<button class="city-item geral' + geralActive + '" data-room="' + ufRoom + '">' +
                '<span>🌎</span><span class="member-nick">Geral do estado</span>' + countBadge(ufRoom) +
              '</button>' +
              cityHtml +
            '</div>' +
          '</div>'
        );
      })
      .join('');

    el.stateList.innerHTML = blocks || '<p class="no-result">Nada encontrado. Tenta outro estado ou cidade.</p>';
  }

  const openStates = new Set();
  function isOpenState(uf) { return openStates.has(uf); }

  function slug(text) {
    return String(text)
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function renderRoomLists() {
    renderThemes(el.searchInput.value);
    renderStates(el.searchInput.value);
  }

  /** atualiza só os números, sem re-renderizar a lista inteira */
  function refreshCounts() {
    document.querySelectorAll('[data-count-for]').forEach((node) => {
      const n = state.counts[node.dataset.countFor] || 0;
      node.textContent = n;
      node.classList.toggle('is-zero', n === 0);
    });
    if (state.currentRoom) {
      const n = state.counts[state.currentRoom] || 0;
      el.roomOnline.textContent = n + (n === 1 ? ' online' : ' online');
    }
  }

  function markActiveRoom() {
    document.querySelectorAll('[data-room]').forEach((node) => {
      node.classList.toggle('is-active', node.dataset.room === state.currentRoom);
    });
  }

  // cliques na barra lateral
  el.sidebar.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-toggle]');
    if (toggle) {
      const uf = toggle.dataset.toggle;
      const block = toggle.closest('.state-block');
      const willOpen = !block.classList.contains('is-open');
      block.classList.toggle('is-open', willOpen);
      if (willOpen) openStates.add(uf); else openStates.delete(uf);
      return;
    }
    const roomBtn = event.target.closest('[data-room]');
    if (roomBtn) joinRoom(roomBtn.dataset.room);
  });

  let searchTimer = null;
  el.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderRoomLists, 120);
  });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('is-active'));
      tab.classList.add('is-active');
      $('#panel-' + tab.dataset.tab).classList.add('is-active');
    });
  });

  // ------------------------------------------------------ assuntos do momento

  /**
   * Top 5 do que está sendo falado agora, com a sala onde o assunto está
   * mais quente. Clicar leva direto para lá.
   */
  function renderAssuntos(lista) {
    const temAlgo = Array.isArray(lista) && lista.length > 0;
    el.trendEmpty.hidden = temAlgo;

    if (!temAlgo) { el.trendList.innerHTML = ''; return; }

    el.trendList.innerHTML = lista.map((item, i) => (
      '<li><button type="button" class="trend-item" data-room="' + escapeHtml(item.salaId) + '">'
      + '<span class="trend-pos">' + (i + 1) + '</span>'
      + '<span class="trend-body">'
      +   '<span class="trend-termo">' + escapeHtml(item.termo) + '</span>'
      +   '<span class="trend-sala">Sala <strong>' + escapeHtml(item.salaNome) + '</strong></span>'
      + '</span>'
      + '<span class="trend-gente">' + item.pessoas + '</span>'
      + '</button></li>'
    )).join('');
  }

  // ------------------------------------------------------ salas

  function joinRoom(roomId) {
    if (!state.socket || !state.me) return;
    state.socket.emit('join', { roomId }, (res) => {
      if (!res || !res.ok) {
        if (res && res.error === 'terms') {
          el.app.hidden = true;
          el.gate.classList.remove('is-out');
          el.gate.style.display = '';
          mostrarPasso('regras');
          return;
        }
        return toast(res && res.error ? res.error : 'Não consegui entrar nessa sala.');
      }

      state.currentRoom = res.room.id;
      state.typingUsers.clear();
      state.members = [];
      renderTyping();
      clearReply();

      el.roomIcon.textContent = res.room.icon;
      el.roomIcon.style.background = res.room.color + '26';
      el.roomName.textContent = res.room.name;
      el.roomTagline.textContent = res.room.tagline;

      el.messageInput.placeholder = 'Manda a braba em ' + res.room.name + '...';
      updateComposerLock();

      // a sala pedida estava cheia e o servidor abriu outra divisão
      if (res.movedTo) {
        toast('Sala lotada — você entrou em ' + res.movedTo);
      }

      renderHistory(res.history || []);
      markActiveRoom();
      refreshCounts();

      if (window.innerWidth <= 780) setSidebar(false);
      el.messageInput.focus();
    });
  }

  // ------------------------------------------------------ mensagens

  function renderHistory(list) {
    state.lastDay = null;
    el.messages.innerHTML = '';
    if (!list.length) {
      el.messages.innerHTML =
        '<div class="empty-state">' +
          '<span class="empty-icon">👋</span>' +
          '<h4>Sala vazia por enquanto</h4>' +
          '<p>Seja o primeiro a puxar assunto. Manda um salve aí embaixo.</p>' +
        '</div>';
      return;
    }
    list.forEach((msg) => appendMessage(msg, { silent: true }));
    scrollToEnd(true);
  }

  function isNearBottom() {
    const box = el.messages;
    return box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  }

  function scrollToEnd(instant) {
    if (instant) {
      el.messages.scrollTop = el.messages.scrollHeight;
    } else {
      el.messages.scrollTo({ top: el.messages.scrollHeight, behavior: 'smooth' });
    }
  }

  function maybeDaySeparator(ts) {
    const label = dayLabel(ts);
    if (label === state.lastDay) return;
    state.lastDay = label;
    const sep = document.createElement('div');
    sep.className = 'day-sep';
    sep.textContent = label;
    el.messages.appendChild(sep);
  }

  function appendMessage(msg, opts) {
    const options = opts || {};
    const emptyInside = el.messages.querySelector('.empty-state');
    if (emptyInside) emptyInside.remove();

    const stick = options.silent || isNearBottom();
    maybeDaySeparator(msg.ts);

    if (msg.type === 'system') {
      const node = document.createElement('div');
      node.className = 'msg-system';
      node.textContent = msg.text;
      el.messages.appendChild(node);
    } else {
      const mine = state.me && msg.authorId === state.me.id;
      const node = document.createElement('div');
      node.className = 'msg' + (mine ? ' is-me' : '');
      node.dataset.id = msg.id;
      node.dataset.nick = msg.nick;
      if (msg.photo) node.dataset.photo = msg.photo;
      if (msg.authorId) node.dataset.author = msg.authorId;
      node.dataset.text = msg.text;

      const reply = msg.replyTo
        ? '<span class="msg-reply"><strong>' + escapeHtml(msg.replyTo.nick) + '</strong>' + escapeHtml(msg.replyTo.text) + '</span>'
        : '';

      node.innerHTML =
        retratoHtml(msg, 'msg-avatar') +
        '<div class="msg-body">' +
          '<div class="msg-head">' +
            '<span class="msg-nick" style="color:' + (mine ? '#cbb8ff' : (msg.color || '#fff')) + '">' + escapeHtml(msg.nick) + '</span>' +
            (msg.mod ? '<span class="mod-badge">MOD</span>' : '') +
            '<span class="msg-time">' + timeLabel(msg.ts) + '</span>' +
          '</div>' +
          '<div class="msg-bubble">' + reply + renderText(msg.text) + '</div>' +
        '</div>' +
        '<div class="msg-tools">' +
          '<button class="reply-btn" type="button" title="Responder">↩</button>' +
          (mine ? '' : '<button class="report-btn" type="button" title="Denunciar">🚩</button>') +
          (state.isMod ? '<button class="del-btn" type="button" title="Apagar (mod)">🗑</button>' : '') +
        '</div>';

      el.messages.appendChild(node);
    }

    if (stick) scrollToEnd(!options.silent ? false : true);
  }

  el.messages.addEventListener('click', (event) => {
    const msg = event.target.closest('.msg');
    if (!msg) return;

    if (event.target.closest('.msg-avatar')) {
      abrirCartao(msg.dataset.author);
      return;
    }

    if (event.target.closest('.reply-btn')) {
      setReply(msg.dataset.nick, msg.dataset.text);
      return;
    }

    if (event.target.closest('.report-btn')) {
      state.socket.emit('report', {
        messageId: msg.dataset.id,
        nick: msg.dataset.nick,
        text: msg.dataset.text,
        photo: msg.dataset.photo || null
      }, (res) => {
        toast(res && res.ok
          ? 'Denúncia enviada. A moderação vai olhar.'
          : (res && res.error) || 'Não deu para denunciar agora.');
      });
      return;
    }

    if (event.target.closest('.del-btn')) {
      state.socket.emit('mod-action', {
        action: 'delete',
        messageId: msg.dataset.id,
        roomId: state.currentRoom,
        nick: msg.dataset.nick
      }, (res) => toast(res && res.message ? res.message : 'Feito.'));
    }
  });

  // ------------------------------------------------------ resposta

  function setReply(nick, text) {
    if (!nick) return;   // sem autor não há o que responder
    state.replyTo = { nick, text: text.slice(0, 120) };
    el.replyNick.textContent = nick;
    el.replyText.textContent = state.replyTo.text;
    el.replyPreview.hidden = false;
    el.messageInput.focus();
  }

  function clearReply() {
    state.replyTo = null;
    el.replyPreview.hidden = true;
  }

  el.cancelReply.addEventListener('click', clearReply);

  // ------------------------------------------------------ envio

  /**
   * Comandos de barra. `/mod <senha>` liga o modo moderador; os outros só
   * respondem para quem já é moderador (o servidor confere de novo).
   */
  const COMMAND_HELP = [
    '/regras — reabre as regras de uso',
    '/mod <senha> — entra como moderador',
    '/mute <apelido> [min] [motivo] — silencia',
    '/ban <apelido> [min] [motivo] — bane e desconecta',
    '/kick <apelido> [motivo] — expulsa (volta se quiser)',
    '/foto <apelido> [motivo] — apaga a foto de perfil',
    '/perfil <apelido> [motivo] — limpa cidade, idade, frase e Instagram',
    '/liberar <apelido> — tira o castigo',
    '/limpar — apaga o histórico da sala',
    '/lista — castigos e denúncias em aberto'
  ].join('\n');

  function runCommand(raw) {
    const parts = raw.slice(1).split(' ').filter(Boolean);
    const cmd = (parts.shift() || '').toLowerCase();

    if (cmd === 'regras') {
      montarRegras(el.rulesBody);
      el.rulesModal.hidden = false;
      return true;
    }

    if (cmd === 'ajuda' || cmd === 'help') {
      systemNotice(COMMAND_HELP);
      return true;
    }

    if (cmd === 'mod') {
      const password = parts.join(' ');
      if (!password) { systemNotice('Uso: /mod <senha>'); return true; }
      state.socket.emit('mod-login', { password }, (res) => {
        if (!res || !res.ok) return toast(res && res.message ? res.message : 'Não rolou.');
        state.isMod = true;
        document.body.classList.add('is-mod');
        systemNotice('Você entrou como moderador. Digite /ajuda para ver os comandos.');
        if (res.reports && res.reports.length) {
          const abertas = res.reports.filter((r) => !r.resolved).length;
          if (abertas) toast('🚨 ' + abertas + ' denúncias em aberto.');
        }
      });
      return true;
    }

    const actions = { mute: 'mute', ban: 'ban', kick: 'kick', liberar: 'pardon', foto: 'photo', perfil: 'wipe-profile' };
    if (actions[cmd]) {
      const nick = parts.shift();
      if (!nick) { systemNotice('Uso: /' + cmd + ' <apelido> [minutos] [motivo]'); return true; }
      const minutes = /^\d+$/.test(parts[0] || '') ? Number(parts.shift()) : null;
      state.socket.emit('mod-action', {
        action: actions[cmd], nick, minutes, reason: parts.join(' ')
      }, (res) => toast(res && res.message ? res.message : 'Feito.'));
      return true;
    }

    if (cmd === 'limpar') {
      state.socket.emit('mod-action', { action: 'clear', roomId: state.currentRoom },
        (res) => toast(res && res.message ? res.message : 'Feito.'));
      return true;
    }

    if (cmd === 'lista') {
      state.socket.emit('mod-action', { action: 'list' }, (res) => {
        if (!res || !res.ok) return toast(res && res.message ? res.message : 'Não rolou.');
        const castigos = res.punishments.length
          ? res.punishments.map((p) => '• ' + (p.nick || p.key) + ' — ' + p.type + ' até ' +
              new Date(p.until).toLocaleTimeString('pt-BR') + ' (' + p.reason + ')').join('\n')
          : '• ninguém de castigo';
        const denuncias = res.reports.filter((r) => !r.resolved);
        const lista = denuncias.length
          ? denuncias.slice(0, 10).map((r) => '• ' + r.nick + ': "' + r.text + '" (por ' + r.byNick + ')').join('\n')
          : '• nenhuma denúncia aberta';
        systemNotice('CASTIGOS\n' + castigos + '\n\nDENÚNCIAS\n' + lista);
      });
      return true;
    }

    systemNotice('Comando desconhecido. Digite /ajuda.');
    return true;
  }

  /** aviso local, só para quem digitou — não vai para a sala */
  function systemNotice(text) {
    const node = document.createElement('div');
    node.className = 'msg-system is-local';
    node.textContent = text;
    el.messages.appendChild(node);
    scrollToEnd(false);
  }

  el.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = el.messageInput.value.trim();
    if (!text || !state.currentRoom) return;

    if (text.startsWith('/')) {
      el.messageInput.value = '';
      runCommand(text);
      return;
    }

    state.socket.emit('message', { text, replyTo: state.replyTo }, (res) => {
      // 'flood', 'muted', 'blocked' e 'auto-mute' já chegam pelo evento 'warning'
      if (res && res.ok === false && !res.error) toast('Mensagem não enviada.');
    });

    el.messageInput.value = '';
    clearReply();
    sendTyping(false);
  });

  function sendTyping(isTyping) {
    if (state.typingSent === isTyping) return;
    state.typingSent = isTyping;
    state.socket.emit('typing', { typing: isTyping });
  }

  el.messageInput.addEventListener('input', () => {
    if (!state.currentRoom) return;
    sendTyping(el.messageInput.value.length > 0);
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => sendTyping(false), 2500);
  });

  el.messageInput.addEventListener('blur', () => sendTyping(false));

  // ------------------------------------------------------ emojis

  // ------------------------------------------------------ digitando

  function renderTyping() {
    const names = Array.from(state.typingUsers.values());
    if (!names.length) { el.typingBar.textContent = ''; return; }
    if (names.length === 1) el.typingBar.textContent = names[0] + ' está digitando...';
    else if (names.length === 2) el.typingBar.textContent = names[0] + ' e ' + names[1] + ' estão digitando...';
    else el.typingBar.textContent = 'várias pessoas estão digitando...';
  }

  // ------------------------------------------------------ membros

  /**
   * O servidor manda a lista completa só quando você entra; depois vêm apenas
   * os deltas (fulano entrou / fulano saiu). Em sala grande a lista vem cortada,
   * então `total` é quem manda no contador.
   */
  function renderMembers(members, total) {
    state.members = members;
    state.membersTotal = typeof total === 'number' ? total : members.length;
    el.membersCount.textContent = state.membersTotal;

    const hidden = state.membersTotal - members.length;
    el.memberList.innerHTML = members
      .map((m) => {
        const you = state.me && m.id === state.me.id ? '<span class="tag-you">você</span>' : '';
        return (
          '<div class="member" data-member="' + m.id + '">' +
            retratoHtml(m, 'member-avatar') +
            '<span class="member-nick" style="color:' + (m.color || '#fff') + '">' + escapeHtml(m.nick) + '</span>' +
            you +
          '</div>'
        );
      })
      .join('') + (hidden > 0 ? '<p class="member-more">+ ' + hidden + ' pessoas nesta sala</p>' : '');
  }

  /** aplica um delta na lista local sem pedir tudo de novo ao servidor */
  function applyMemberDelta(data, joined) {
    if (data.roomId !== state.currentRoom) return;
    let list = state.members.filter((m) => m.id !== (joined ? data.member.id : data.id));
    if (joined) {
      list.push(data.member);
      list.sort((a, b) => a.nick.localeCompare(b.nick, 'pt-BR'));
      if (list.length > 80) list = list.slice(0, 80);   // mesmo corte do servidor
    }
    renderMembers(list, data.total);
  }

  el.memberList.addEventListener('click', (event) => {
    const linha = event.target.closest('[data-member]');
    if (linha) abrirCartao(linha.dataset.member);
  });

  el.toggleMembers.addEventListener('click', () => el.app.classList.toggle('show-members'));
  el.closeMembers.addEventListener('click', () => el.app.classList.remove('show-members'));

  // ------------------------------------------------------ menu mobile

  function setSidebar(open) {
    el.app.classList.toggle('show-sidebar', open);
    el.scrim.hidden = !open;
  }
  el.openSidebar.addEventListener('click', () => setSidebar(true));
  el.closeSidebar.addEventListener('click', () => setSidebar(false));
  el.scrim.addEventListener('click', () => setSidebar(false));

  el.editMe.addEventListener('click', abrirEditorPerfil);
  el.meCard.addEventListener('click', (event) => {
    if (!event.target.closest('#edit-me')) abrirEditorPerfil();
  });


  // ------------------------------------------------------ socket

  /** identidade local, para castigo de moderação não sumir com um F5 */
  function deviceToken() {
    try {
      let token = localStorage.getItem('cm_token');
      if (!token) {
        token = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now().toString(36));
        localStorage.setItem('cm_token', token);
      }
      return token;
    } catch (e) {
      return String(Math.random()).slice(2) + Date.now().toString(36);
    }
  }

  function connect() {
    const socket = io({ transports: ['websocket', 'polling'], auth: { token: deviceToken() } });
    state.socket = socket;

    socket.on('welcome', (data) => {
      state.avatars = data.avatars;
      if (!el.avatarGrid.children.length) renderAvatarPicker();
      comecarDoZero();
    });

    socket.on('trending', renderAssuntos);

    socket.on('counts', (data) => {
      state.counts = data.counts || {};
      el.gateOnline.textContent = data.online || 0;
      refreshCounts();
    });

    // as mensagens chegam em lote: uma só em sala calma, várias em sala cheia
    socket.on('messages', (list) => {
      for (const msg of list) {
        if (msg.roomId === state.currentRoom) appendMessage(msg);
      }
    });

    socket.on('message-deleted', (data) => {
      if (data.roomId !== state.currentRoom) return;
      const node = el.messages.querySelector('[data-id="' + data.id + '"]');
      if (node) node.remove();
    });

    socket.on('room-cleared', (data) => {
      if (data.roomId !== state.currentRoom) return;
      el.messages.innerHTML = '';
      state.lastDay = null;
    });

    socket.on('muted', (data) => {
      state.mutedUntil = data.until;
      toast('Você foi silenciado. Motivo: ' + data.reason);
      updateComposerLock();
    });

    socket.on('banned', (data) => {
      state.banned = true;
      showBlocked('Você foi banido', data.reason, data.until);
    });

    socket.on('kicked', (data) => {
      showBlocked('Você foi expulso', data.reason, null);
    });

    socket.on('report', (report) => {
      if (!state.isMod) return;
      toast('🚨 Denúncia de ' + report.byNick + ' sobre ' + report.nick);
    });

    socket.on('auto-mute', (data) => {
      if (!state.isMod) return;
      toast('🤖 ' + data.nick + ' silenciado ' + data.minutes + 'min: ' + data.reason);
    });

    socket.on('members', (data) => {
      if (data.roomId !== state.currentRoom) return;
      renderMembers(data.members, data.total);
    });

    socket.on('member-joined', (data) => applyMemberDelta(data, true));
    socket.on('member-left', (data) => applyMemberDelta(data, false));

    socket.on('typing', (data) => {
      if (data.typing) state.typingUsers.set(data.id, data.nick);
      else state.typingUsers.delete(data.id);
      renderTyping();
    });

    socket.on('profile-wiped', (data) => {
      state.profile = null;
      toast('Seu perfil foi limpo pela moderação. Motivo: ' + data.reason);
    });

    socket.on('photo-removed', (data) => {
      state.photo = null;
      if (state.me) state.me.photo = null;
      mostrarRetrato();
      pintarMeCard();
      toast('Sua foto foi removida pela moderação. Motivo: ' + data.reason);
    });

    socket.on('warning', (data) => toast(data.text));

    socket.on('overloaded', (data) => {
      showBlocked('Chat lotado', data.text, null);
    });

    socket.on('disconnect', () => toast('Conexão caiu. Reconectando...'));
    socket.on('connect', () => {
      if (!state.me || !state.currentRoom) return;
      // ao reconectar, retoma o mesmo apelido (ele foi liberado quando a conexão caiu)
      const roomId = state.currentRoom;
      const versao = state.terms ? state.terms.versao : '';
      socket.emit('login', {
        nick: state.me.nick, avatar: state.me.avatar, terms: versao
      }, (res) => {
        if (res && res.ok) {
          state.me = res.me;
          reenviarPerfil();
          joinRoom(roomId);
          return;
        }
        // alguém pegou o apelido nesse intervalo: volta para a tela de entrada
        backToGate(res && res.message ? res.message : 'Precisa escolher um apelido de novo.');
      });
    });
  }

  /**
   * Cada visita começa do zero: apelido em branco, sem foto, sem perfil.
   *
   * É o esperado num chat anônimo — a pessoa pode querer entrar com outro
   * nome, ou estar num computador emprestado, e reencontrar a foto e o
   * apelido da última vez seria no mínimo constrangedor.
   *
   * Sobrevivem ao fechar a aba apenas duas coisas, e nenhuma delas aparece
   * na tela: o token do aparelho (para castigo de moderação não sumir com
   * um F5) e o aceite das regras.
   */
  function comecarDoZero() {
    state.photo = null;
    state.profile = null;
    state.avatar = null;
    el.nickInput.value = '';

    try {
      // limpa também o que versões anteriores tinham deixado guardado
      ['cm_nick', 'cm_avatar', 'cm_photo', 'cm_profile'].forEach((chave) => {
        localStorage.removeItem(chave);
      });
    } catch (e) { /* localStorage bloqueado, segue o jogo */ }

    el.avatarGrid.querySelectorAll('.avatar-opt').forEach((b) => b.classList.remove('is-active'));
    fecharEmojis();
    mostrarRetrato();
  }

  // ------------------------------------------------------ boot

  async function boot() {
    connect();
    try {
      const [salas, regras] = await Promise.all([
        fetch('/api/rooms').then((r) => r.json()),
        fetch('/api/terms').then((r) => r.json())
      ]);
      state.rooms = salas;
      state.terms = regras;
      el.termsAge.textContent = regras.idade;
    } catch (e) {
      toast('Não consegui carregar as salas.');
      return;
    }

    const totalCities = state.rooms.states.reduce((sum, s) => sum + s.cities.length, 0);
    el.gateRooms.textContent = state.rooms.themes.length + state.rooms.states.length + totalCities;
    el.roomTagline.textContent = el.gateRooms.textContent + ' salas esperando você';

    renderRoomLists();
    el.nickInput.focus();
  }

  boot();
})();
