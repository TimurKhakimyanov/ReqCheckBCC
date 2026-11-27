# Служебный образ инфраструктуры: бэкап/восстановление и смоук-тест.
# pg_dump/pg_restore той же мажорной версии, что и сервер postgres в compose.yaml.
FROM postgres:18.7-alpine

RUN apk add --no-cache bash curl jq rclone redis tar gzip coreutils

COPY *.sh /opt/reqcheck/
RUN chmod +x /opt/reqcheck/*.sh

WORKDIR /backups
ENTRYPOINT ["/opt/reqcheck/entrypoint.sh"]
CMD ["smoke"]
