FROM node:20-alpine

ARG GIT_COMMIT=unknown
LABEL git.commit=$GIT_COMMIT

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["node", "dist/index.js"]
