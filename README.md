# CHATMAROMBA 💪

Bate-papo em tempo real da marombada. Salas separadas por **tema** (com ícone e nome) e por **estado / cidade**.

## Rodar

```bash
npm install
npm start          # http://localhost:3000
```

Porta customizada: `PORT=8080 npm start`.

## Salas

**176 salas** no total, em três tipos:

| Tipo | Id | Exemplo |
|---|---|---|
| Tema (nacional) | `tema:<id>` | `tema:venenos` |
| Estado — geral | `uf:<UF>` | `uf:SP` |
| Cidade | `cidade:<UF>:<slug>` | `cidade:SP:santos` |

Temas: 🏠 Geral · 🔥 Emagrecimento · 💪 Ganho de Peso · 💊 Venenos · ⚔️ Treta · 💘 Paquera ·
🍗 Dieta & Receitas · 🏋️ Treino & Fichas · 🥤 Suplementos · 🌱 Natural · 🏆 Competição ·
🩺 Lesões & Saúde · 🧠 Motivação · 😂 Zoeira

Estados: os 27 (26 + DF), cada um com uma sala **Geral** que junta o estado inteiro, mais as
principais cidades. Para incluir mais cidades, é só adicionar na lista em
[shared/rooms.js](shared/rooms.js) — servidor e frontend se atualizam sozinhos.

## Como funciona

- **[server.js](server.js)** — Express serve os estáticos e a API; Socket.IO cuida das mensagens.
  Estado fica **em memória**: histórico de 80 mensagens por sala, apagado ao reiniciar.
- **[shared/rooms.js](shared/rooms.js)** — catálogo único de salas (temas, estados, cidades).
- **[public/](public/)** — frontend sem build e sem framework: HTML + CSS + JS puro.

### API

| Rota | Retorno |
|---|---|
| `GET /api/rooms` | temas e estados/cidades |
| `GET /api/terms` | regras de uso e versão vigente |
| `GET /api/stats` | total online e ocupação por sala |
| `POST /api/avatar` | envia a foto de perfil (JPEG cru, cabeçalho `X-Device-Token`) |
| `GET /avatar/:id` | entrega a foto |
| `GET /health` | status do processo |

### Eventos Socket.IO

`login` · `check-nick` · `join` · `message` · `typing` · `leave` → cliente para servidor
`welcome` · `message` · `members` · `counts` · `typing` · `warning` → servidor para cliente

## Recursos

- Apelido + avatar sem cadastro (guardados no `localStorage`)
- **Foto de perfil opcional**: a imagem é cortada e comprimida no navegador (128x128 JPEG,
  ~8 KB) antes de subir. Fica só na memória do servidor e some no restart. O emoji continua
  valendo para quem não quiser aparecer
- **Apelido exclusivo enquanto a pessoa está online**: ninguém mais consegue usar o mesmo nome
  ao mesmo tempo. A comparação ignora acento, maiúscula e espaço (`Monstro` = `mónstro` = `MONSTRO`).
  Quando a pessoa sai, o apelido é liberado na hora para quem quiser
- Contador de gente online por sala, ao vivo
- Busca por tema, estado ou cidade
- Responder mensagem, indicador de "digitando", seletor de emoji
- Lista de quem está na sala
- Anti-flood: 12 mensagens a cada 10 s
- Escape de HTML em tudo que o usuário manda; links viram `<a>` seguros
- Layout responsivo, com menu lateral em gaveta no celular

## Testes

Com o servidor rodando:

```bash
npm test
```

Sobe três clientes, entra em salas de tema/estado/cidade, troca mensagens e checa
histórico, membros e anti-flood.

## Regras de uso

O texto fica em [shared/terms.js](shared/terms.js), num lugar só, e alimenta três pontos:
a tela de entrada, o comando `/regras` e a checagem do servidor.

A aceitação é **verificada no servidor**: sem ela, `join` responde `error: terms` e a pessoa
não entra em sala nenhuma. Travar só na tela seria enfeite — bastaria falar direto com o
socket para pular.

Ao mudar o texto, **mude também a `VERSAO`**. Quem já aceitou volta a ver a tela, que é o
comportamento certo quando as regras mudam.

## Moderação

Ligue definindo `MOD_PASSWORD` no servidor. Sem essa variável, a moderação humana
fica desligada (o filtro automático continua funcionando).

No chat, digite os comandos no próprio campo de mensagem:

| Comando | O que faz |
|---|---|
| `/mod <senha>` | entra como moderador |
| `/mute <apelido> [min] [motivo]` | silencia (padrão 10 min) |
| `/ban <apelido> [min] [motivo]` | bane e desconecta (padrão 60 min) |
| `/kick <apelido> [motivo]` | expulsa, mas pode voltar |
| `/foto <apelido> [motivo]` | apaga a foto de perfil da pessoa |
| `/liberar <apelido>` | tira o castigo |
| `/limpar` | apaga o histórico da sala |
| `/lista` | castigos e denúncias em aberto |
| `/regras` | reabre as regras de uso |
| `/ajuda` | mostra tudo isso |

Moderador também ganha 🗑 para apagar mensagem, e qualquer pessoa ganha 🚩 para denunciar.
Denúncia chega ao vivo para quem estiver de plantão.

**Como a punição identifica a pessoa:** por um token que o navegador guarda, **não** pelo IP.
Operadoras móveis brasileiras usam CGNAT — milhares de pessoas dividem o mesmo IP, e banir
por endereço calaria gente inocente. O banimento (só ele) também prende o IP como reforço,
para não bastar limpar o navegador; `BAN_BY_IP=0` desliga esse reforço.

### Filtro automático

Funciona sem moderador acordado: silencia quem repete a mesma mensagem 3 vezes seguidas,
silencia quem insiste em link (4 mensagens com link em 30s), barra mais de 2 links numa
mensagem só, encolhe `aaaaaaaa` e abaixa o TEXTO TODO EM CAIXA ALTA em vez de bloquear.

## Segurança

Rode a sonda de abuso com o servidor de pé — ela tenta o que um atacante tentaria,
e cada linha passa quando o servidor **se defende**:

```bash
MOD_PASSWORD=segredo PORT=3555 MAX_SOCKETS_PER_IP=20 node server.js
CHAT_URL=http://localhost:3555 MOD_PASSWORD=segredo node test/attack.js
```

| Ataque | Defesa |
|---|---|
| Salas fantasma (`tema:geral~999999`) | id de sala validado: tema tem que existir e a divisão tem que estar na faixa |
| Força bruta na senha do moderador | 5 tentativas a cada 10 min por conexão |
| Evento de 900 KB | `maxHttpBufferSize` de 16 KB — a conexão cai |
| Enxurrada de "digitando" | 60 a cada 10 s; o excesso é ignorado |
| Troca de sala em looping | 25 entradas por minuto |
| Reservar apelidos em massa | teto de conexões por IP e global |
| **Trocar de IP mentindo o `X-Forwarded-For`** | cabeçalho só vale atrás de proxy conhecido, e lendo a ponta que o proxy escreveu |
| Enxurrada de requisições HTTP | balde de fichas por IP, responde 429 |
| XSS na mensagem | escape de HTML + `Content-Security-Policy` travando script de fora |
| Impressão digital do servidor | `X-Powered-By` desligado |
| Arquivo disfarçado de foto | confere os bytes mágicos do JPEG; serve sempre como `image/jpeg` + `nosniff` |
| Enxurrada de upload | balde próprio, 10 por minuto por IP |

O `/health` mostra os contadores de recusa. Se `recusas.porIp` subir com o chat
funcionando normal, o limite está apertado demais e está barrando gente de verdade —
**suba o `MAX_SOCKETS_PER_IP`**, não deixe usuário na porta. O padrão (120) é alto de
propósito por causa do CGNAT das operadoras móveis brasileiras.

### O que isso NÃO resolve

Ataque distribuído de verdade, com milhares de máquinas, não se resolve dentro do
Node. Se acontecer, o caminho é pôr um **Cloudflare na frente** (plano grátis já
proxia WebSocket) ou usar as regras de firewall da própria Fly.

## Aguenta quanta gente?

Medido com [test/load.js](test/load.js), 1000 conexões reais numa máquina comum:

| Situação | Entregas/s | p95 | Perda |
|---|---|---|---|
| 1000 numa sala só, ~30 msg/s | 29.400 | 26 ms | 0% |
| 1000 numa sala só, ~128 msg/s | 128.000 | **20.800 ms** | 0% |
| 1000 divididos em 4 salas, ~95 msg/s | 23.900 | **104 ms** | 0% |

A terceira linha é o comportamento atual. `ROOM_CAPACITY` (padrão 250) divide sala cheia em
"Sala 2", "Sala 3"... Cada mensagem passa a alcançar 250 pessoas em vez de 1000, o que corta a
banda — o maior custo de um chat — na mesma proporção, e ainda deixa o papo legível.

```bash
node test/load.js 1000 40 15    # 1000 clientes, 40 msg/s, 15 segundos
# num teste local, suba MAX_SOCKETS_PER_IP: tudo vem do mesmo IP
```

## Deploy

O projeto sobe em qualquer host que rode Node e aceite WebSocket. **Não funciona** em
Vercel/Netlify no modo serverless — o Socket.IO precisa de um processo que fique de pé.

### Render (plano grátis)

1. Suba o código para um repositório no GitHub.
2. No [dashboard do Render](https://dashboard.render.com): **New +** → **Blueprint** → escolha o
   repositório. O [render.yaml](render.yaml) já traz plano, build, start e health check.
3. Depois do primeiro deploy, copie a URL gerada e crie a variável de ambiente
   `ALLOWED_ORIGIN` com ela (ex.: `https://chatmaromba.onrender.com`). Isso trava os sockets
   no seu domínio. Salvar dispara um novo deploy.

No plano grátis o serviço hiberna após ~15 min sem visitas e leva alguns segundos para acordar.

### Docker (Fly.io, Railway, VPS)

```bash
docker build -t chatmaromba .
docker run -p 3000:3000 -e ALLOWED_ORIGIN=https://seu-dominio.com chatmaromba
```

### Variáveis de ambiente

| Variável | Padrão | Para que serve |
|---|---|---|
| `PORT` | `3000` | Porta HTTP (os hosts definem sozinhos) |
| `ALLOWED_ORIGIN` | `*` | Domínios que podem abrir socket, separados por vírgula |
| `MOD_PASSWORD` | — | Senha do `/mod`. Sem ela, não há moderador humano |
| `ROOM_CAPACITY` | `250` | Pessoas por sala antes de abrir uma divisão nova |
| `BAN_BY_IP` | `1` | `0` desliga o reforço de IP no banimento |
| `IP_SALT` | sorteado | Fixe para os castigos sobreviverem a um restart |
| `MAX_SOCKETS_TOTAL` | `3000` | Teto global de conexões |
| `MAX_SOCKETS_PER_IP` | `120` | Conexões por IP (alto por causa do CGNAT) |
| `NEW_PER_MINUTE_PER_IP` | `90` | Conexões novas por minuto, por IP |
| `TRUST_PROXY` | auto | `1` força confiar no proxy, `0` desliga |
| `MAX_PHOTO_BYTES` | `49152` | Tamanho máximo da foto já encolhida |
| `MAX_PHOTOS` | `1500` | Fotos guardadas na memória antes de descartar as antigas |

## Antes de colocar no ar

Este projeto roda em memória e sem autenticação — ótimo para uso local ou um deploy simples.
Para um chat público de verdade, considere:

- Banco (Redis/Postgres) para histórico e usuários
- Moderação: banimento, palavras bloqueadas, denúncia
- Rate limit por IP no HTTP, além do limite por socket já existente
- HTTPS e `cors.origin` restrito ao seu domínio em [server.js](server.js)
