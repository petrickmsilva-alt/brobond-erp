# ============================================================================
# BROBOND ERP — imagem para VPS (HostGator) COM A MESMA VERSÃO DA APLICAÇÃO.
#
# Regra do benchmark: Render × VPS só é comparação se rodar o MESMO código, o
# MESMO runtime, o MESMO banco (Neon) e a MESMA configuração de conexões.
# Por isso:
#   • imagem única servindo API + front buildado (igual à Render);
#   • runtime `tsx` — o MESMO comando de start da Render. Trocar para build
#     compilado aqui e não lá mediria outra aplicação;
#   • variáveis lidas do ambiente, nenhuma credencial na imagem;
#   • healthcheck no mesmo endpoint usado pela plataforma.
# ============================================================================
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# `npm ci` reproduz EXATAMENTE o lockfile — evita "funciona na VPS, falha na Render".
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/
COPY packages ./packages
RUN npm ci --include=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# tini: PID 1 correto para o Express receber SIGTERM e encerrar conexões limpas.
RUN apt-get update && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app ./
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health/db').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "--workspace", "server", "start"]
