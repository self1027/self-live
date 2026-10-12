#!/usr/bin/env bash
# Provisionamento independente de Coturn: Debian/Ubuntu, systemd, TLS obrigatório.
set +x
set -Eeuo pipefail
umask 077
[[ $EUID -eq 0 ]] || { printf 'Execute: sudo bash scripts/setup-relay.sh\n' >&2; exit 1; }
[[ -d /run/systemd/system ]] && command -v apt-get >/dev/null
exec 9>/run/lock/self-live-relay-setup.lock
flock -x 9
trap 'printf "Falha no setup do relay na linha %s.\n" "$LINENO" >&2' ERR
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../relay" && pwd)
DOMAIN=${SELF_LIVE_RELAY_DOMAIN:-}
if [[ -n "$DOMAIN" && ! "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]]; then
  printf 'SELF_LIVE_RELAY_DOMAIN inválido.\n' >&2; exit 1
fi
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates openssl ufw
if ! command -v node >/dev/null || (( $(node -p 'Number(process.versions.node.split(".")[0])') < 22 )); then
  nodesource_script=$(mktemp)
  trap 'rm -f -- "$nodesource_script"' EXIT
  curl -fsSL https://deb.nodesource.com/setup_22.x -o "$nodesource_script"
  bash "$nodesource_script"
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi
getent group self-live-relay >/dev/null || groupadd --system self-live-relay
id -u self-live-relay >/dev/null 2>&1 || useradd --system --gid self-live-relay \
  --home-dir /opt/self-live-relay --no-create-home --shell /usr/sbin/nologin self-live-relay
install -d -o root -g self-live-relay -m 0750 /opt/self-live-relay /etc/self-live-relay /etc/self-live-relay/tls
install -o root -g self-live-relay -m 0640 "$SOURCE_DIR/server.js" /opt/self-live-relay/server.js
install -o root -g self-live-relay -m 0640 "$SOURCE_DIR/package.json" /opt/self-live-relay/package.json
install -o root -g self-live-relay -m 0640 "$SOURCE_DIR/package-lock.json" /opt/self-live-relay/package-lock.json
(cd /opt/self-live-relay && npm ci --omit=dev --ignore-scripts)
chmod -R a+rX /opt/self-live-relay/node_modules
if [[ -n "$DOMAIN" ]]; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y certbot
  ufw allow 80/tcp comment 'Self Live relay ACME'
  # Porta 80 deve estar disponível e o DNS deve apontar à VPS.
  certbot certonly --standalone --non-interactive --agree-tos --register-unsafely-without-email \
    --keep-until-expiring --cert-name self-live-relay -d "$DOMAIN"
  install -o root -g self-live-relay -m 0640 /etc/letsencrypt/live/self-live-relay/privkey.pem /etc/self-live-relay/tls/key.pem
  install -o root -g self-live-relay -m 0640 /etc/letsencrypt/live/self-live-relay/fullchain.pem /etc/self-live-relay/tls/cert.pem
  install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
  cat > /etc/letsencrypt/renewal-hooks/deploy/self-live-relay <<'HOOK'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${RENEWED_LINEAGE:-}" == '/etc/letsencrypt/live/self-live-relay' ]] || exit 0
install -o root -g self-live-relay -m 0640 "$RENEWED_LINEAGE/privkey.pem" /etc/self-live-relay/tls/key.pem
install -o root -g self-live-relay -m 0640 "$RENEWED_LINEAGE/fullchain.pem" /etc/self-live-relay/tls/cert.pem
systemctl try-restart self-live-relay.service
HOOK
  chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/self-live-relay
  systemctl enable --now certbot.timer
elif [[ ! -f /etc/self-live-relay/tls/key.pem || ! -f /etc/self-live-relay/tls/cert.pem ]]; then
  openssl req -x509 -newkey rsa:3072 -sha256 -days 365 -nodes \
    -subj '/CN=Self Live signaling relay' -addext 'subjectAltName=IP:72.61.63.75' \
    -keyout /etc/self-live-relay/tls/key.pem -out /etc/self-live-relay/tls/cert.pem
fi
chown root:self-live-relay /etc/self-live-relay/tls/{key,cert}.pem
chmod 0640 /etc/self-live-relay/tls/{key,cert}.pem
if [[ ! -e /etc/self-live-relay/config.json ]]; then
  printf '{ "port": 8443, "maxRooms": 1000, "maxPeersPerRoom": 30 }\n' > /etc/self-live-relay/config.json
fi
chown root:self-live-relay /etc/self-live-relay/config.json
chmod 0640 /etc/self-live-relay/config.json
cat > /etc/systemd/system/self-live-relay.service <<'UNIT'
[Unit]
Description=Self Live TLS signaling relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=self-live-relay
Group=self-live-relay
WorkingDirectory=/opt/self-live-relay
ExecStart=/usr/bin/node /opt/self-live-relay/server.js
Restart=on-failure
RestartSec=2
TimeoutStopSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
ufw allow 8443/tcp comment 'Self Live signaling relay TLS'
systemctl daemon-reload
systemctl enable self-live-relay.service
systemctl restart self-live-relay.service
healthy=false
for _ in {1..20}; do
  # Não enviar credenciais neste probe local; o pin é validado pelos peers.
  if [[ $(curl -ksS --max-time 2 -o /dev/null -w '%{http_code}' https://127.0.0.1:8443/health || true) == 200 ]]; then
    healthy=true; break
  fi
  sleep 1
done
[[ $healthy == true ]] || { printf 'Relay sem health 200; veja journalctl -u self-live-relay.\n' >&2; exit 1; }
printf '\nRelay pronto: wss://%s:8443\nSHA-256 do certificado:\n' "${DOMAIN:-72.61.63.75}"
openssl x509 -in /etc/self-live-relay/tls/cert.pem -noout -fingerprint -sha256
