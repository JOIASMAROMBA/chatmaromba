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
| `GET /api/stats` | total online e ocupação por sala |
| `GET /health` | status do processo |

### Eventos Socket.IO

`login` · `check-nick` · `join` · `message` · `typing` · `leave` → cliente para servidor
`welcome` · `message` · `members` · `counts` · `typing` · `warning` → servidor para cliente

## Recursos

- Apelido + avatar sem cadastro (guardados no `localStorage`)
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

## Antes de colocar no ar

Este projeto roda em memória e sem autenticação — ótimo para uso local ou um deploy simples.
Para um chat público de verdade, considere:

- Banco (Redis/Postgres) para histórico e usuários
- Moderação: banimento, palavras bloqueadas, denúncia
- Rate limit por IP no HTTP, além do limite por socket já existente
- HTTPS e `cors.origin` restrito ao seu domínio em [server.js](server.js)
