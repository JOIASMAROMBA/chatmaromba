FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# instala só as dependências de produção, aproveitando o cache de camadas
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
