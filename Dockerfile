# Dadaguard — immagine unica: builda il frontend, poi Express serve dist/ + /api.
# Build:  docker build -t dadaguard .
# Run:    docker run -p 3001:3001 -v $PWD/services.yaml:/app/services.yaml dadaguard
# (in cloud: niente profili SSO → l'auth AWS usa il task role + AssumeRole, vedi config roleArn)

# --- build frontend ---
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --legacy-peer-deps
COPY . .
RUN npm run build

# --- runtime ---
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev --legacy-peer-deps && npm cache clean --force
COPY server ./server
COPY --from=build /app/dist ./dist
# services.yaml NON è nell'immagine: montalo a runtime (-v) o derivalo da Terraform.
EXPOSE 3001
CMD ["node", "server/index.js"]
