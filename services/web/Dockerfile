# ЗАГЛУШКА каркаса: заменяется сессией «Веб». Контекст сборки — корень репозитория.
# Обязательные стадии: runtime (nginx, порт 8080) и test.
FROM nginx:1.27-alpine AS runtime
RUN sed -i 's/listen       80;/listen 8080;/' /etc/nginx/conf.d/default.conf
EXPOSE 8080

FROM alpine:3.20 AS test
CMD ["echo", "no tests yet"]
