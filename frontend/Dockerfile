FROM node:20-slim AS build

WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
# Proxy /api requests to backend
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
