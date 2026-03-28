FROM node:20-slim

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY index.js .
COPY public/ public/

EXPOSE 8000

CMD ["node", "index.js"]
