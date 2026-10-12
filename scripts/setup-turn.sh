#!/usr/bin/env bash
# Setup idempotente do relay TURN Self Live em Debian/Ubuntu com systemd.
# Execute na VPS: sudo bash scripts/setup-turn.sh
# Nunca habilite xtrace: a única saída com segredo é o resumo solicitado no final.
set +x
set -Eeuo pipefail
umask 077

readonly PUBLIC_IP='72.61.63.75'
readonly SECRET_FILE='/etc/turnserver.secret'
readonly CONFIG_FILE='/etc/turnserver.conf'
readonly UNIT_FILE='/etc/systemd/system/coturn.service'
temporary_files=()

cleanup() {
  local file
  for file in "${temporary_files[@]}"; do
    rm -f -- "$file"
  done
}
trap cleanup EXIT
trap 'printf "Erro de setup na linha %s; detalhes sensíveis foram omitidos.\n" "$LINENO" >&2' ERR

if [[ ${EUID} -ne 0 ]]; then
  printf 'Execute como root: sudo bash scripts/setup-turn.sh\n' >&2
  exit 1
fi
if ! command -v apt-get >/dev/null || [[ ! -d /run/systemd/system ]]; then
  printf 'Este script requer Debian/Ubuntu com apt e systemd em execução.\n' >&2
  exit 1
fi

# Evita duas execuções concorrentes gerarem segredos diferentes.
exec 9>/run/lock/self-live-turn-setup.lock
flock -x 9

missing_packages=()
for package in coturn ufw openssl python3 iproute2; do
  if [[ $(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true) != 'install ok installed' ]]; then
    missing_packages+=("$package")
  fi
done
if (( ${#missing_packages[@]} )); then
  printf 'Instalando dependências do relay TURN...\n'
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing_packages[@]}"
fi

if [[ -L "$SECRET_FILE" ]] || [[ -e "$SECRET_FILE" && ! -f "$SECRET_FILE" ]]; then
  printf 'O arquivo de segredo deve ser regular e não pode ser um link.\n' >&2
  exit 1
fi
if [[ ! -e "$SECRET_FILE" ]]; then
  secret_temp=$(mktemp /etc/.self-live-turn-secret.XXXXXX)
  temporary_files+=("$secret_temp")
  openssl rand -hex 32 > "$secret_temp"
  install -o root -g root -m 0600 "$secret_temp" "$SECRET_FILE"
fi
chown root:root "$SECRET_FILE"
chmod 0600 "$SECRET_FILE"
TURN_SECRET=$(<"$SECRET_FILE")
if [[ ! "$TURN_SECRET" =~ ^[[:xdigit:]]{64}$ ]]; then
  printf 'Segredo existente inválido: esperado exatamente 64 caracteres hexadecimais; não foi regenerado.\n' >&2
  exit 1
fi

# O daemon lê a cópia no .conf; o arquivo original permanece root:root 0600.
getent group turnserver >/dev/null || groupadd --system turnserver
id -u turnserver >/dev/null 2>&1 || useradd --system --gid turnserver --home-dir /var/lib/turn --no-create-home --shell /usr/sbin/nologin turnserver
config_temp=$(mktemp /etc/.self-live-turn-config.XXXXXX)
temporary_files+=("$config_temp")

# no-loopback-peers foi removido em Coturn recente: negar loopback já é default.
# Não ativamos allow-loopback-peers nem para o teste. A opção antiga só é escrita
# como diretiva quando a versão instalada a reconhece.
turn_help=$(turnserver --help 2>&1 || true)
loopback_option='# no-loopback-peers: loopback bloqueado por padrão nesta versão'
if [[ "$turn_help" == *'--no-loopback-peers'* ]]; then
  loopback_option='no-loopback-peers'
fi
dtls_option='# DTLS desabilitado por padrão nesta versão'
if [[ "$turn_help" == *'--no-dtls'* ]]; then
  dtls_option='no-dtls'
fi
# Coturn pode usar o endereço local do listener (127.0.0.1 no pós-check)
# quando relay-ip não é explícito. Selecionamos um endereço real da VPS,
# priorizando o IP público configurado, depois a interface da rota de saída.
relay_ip=$(python3 - "$PUBLIC_IP" <<'PY'
import ipaddress
import json
import subprocess
import sys

public = sys.argv[1]
interfaces = json.loads(subprocess.check_output(['ip', '-j', '-4', 'address', 'show', 'up']))
addresses = []
for interface in interfaces:
    for address in interface.get('addr_info', []):
        value = address.get('local', '')
        ip = ipaddress.ip_address(value)
        if ip.version == 4 and not ip.is_loopback and not ip.is_unspecified and not ip.is_multicast and not ip.is_link_local:
            addresses.append(value)
if public in addresses:
    print(public)
else:
    routes = json.loads(subprocess.check_output(['ip', '-j', '-4', 'route', 'get', public]))
    preferred = next((route.get('prefsrc') or route.get('src') for route in routes if (route.get('prefsrc') or route.get('src')) in addresses), None)
    if preferred:
        print(preferred)
    elif addresses:
        print(addresses[0])
    else:
        sys.exit(1)
PY
)
cat > "$config_temp" <<EOF
# Gerenciado por scripts/setup-turn.sh. Contém segredo: não compartilhe.
listening-port=3478
tls-listening-port=5349
fingerprint
# Mantido conforme o projeto; use-auth-secret já habilita lt-cred-mech internamente.
lt-cred-mech
use-auth-secret
static-auth-secret=${TURN_SECRET}
realm=self-live.local
external-ip=${PUBLIC_IP}
relay-ip=${relay_ip}
min-port=49152
max-port=65535
no-cli
no-multicast-peers
${loopback_option}
total-quota=100
bps-capacity=0
user-quota=12
# Logs nativos incluem IPs e identidades TURN; não os persistimos nem exibimos.
no-stdout-log
simple-log
log-file=/dev/null
# Sem certificado/chave, este setup oferece TURN UDP/TCP em 3478.
# A abertura de 5349 não provisiona TLS/DTLS; consulte docs/turn-setup.md.
no-tls
${dtls_option}
EOF
install -o root -g turnserver -m 0640 "$config_temp" "$CONFIG_FILE"

unit_temp=$(mktemp /etc/.self-live-coturn-unit.XXXXXX)
temporary_files+=("$unit_temp")
cat > "$unit_temp" <<'EOF'
[Unit]
Description=Self Live Coturn STUN/TURN relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=turnserver
Group=turnserver
RuntimeDirectory=coturn
RuntimeDirectoryMode=0750
ExecStart=/usr/bin/turnserver -c /etc/turnserver.conf --pidfile=/run/coturn/turnserver.pid
StandardOutput=null
StandardError=null
Restart=on-failure
RestartSec=3
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
install -o root -g root -m 0644 "$unit_temp" "$UNIT_FILE"

# Adicionar regras é idempotente. Não alteramos nem habilitamos o firewall:
# habilitar UFW remotamente sem preservar a porta SSH pode cortar o acesso.
ufw allow 3478/udp comment 'Self Live TURN'
ufw allow 3478/tcp comment 'Self Live TURN'
ufw allow 5349/udp comment 'Self Live TURN TLS'
ufw allow 5349/tcp comment 'Self Live TURN TLS'
ufw allow 49152:65535/udp comment 'Self Live TURN media'

systemctl daemon-reload
systemctl enable coturn
systemctl restart coturn
# Sem as linhas do journal: elas podem conter IPs/clientes/usuários efêmeros.
systemctl --no-pager --full --lines=0 status coturn
systemctl is-active --quiet coturn

# Gera só credenciais efêmeras. O segredo nunca vira argumento de processo.
# -y cria dois clientes com allocations relay que trocam pacotes entre si;
# 127.0.0.1 é o endereço do servidor, não um peer de mídia proibido.
printf 'Validando autenticação e relay com turnutils_uclient (servidor loopback)...\n'
mapfile -t test_credentials < <(python3 - "$SECRET_FILE" <<'PY'
import base64
import hashlib
import hmac
from pathlib import Path
import sys
import time

secret = Path(sys.argv[1]).read_text().strip().encode('ascii')
username = f'{int(time.time()) + 300}:self-live-setup'
credential = base64.b64encode(hmac.new(secret, username.encode(), hashlib.sha1).digest()).decode()
print(username)
print(credential)
PY
)
if (( ${#test_credentials[@]} != 2 )); then
  printf 'Não foi possível gerar credenciais efêmeras de verificação.\n' >&2
  exit 1
fi
test_ok=false
# Pequena espera/repetição de prontidão do serviço; não é reconexão do app.
for attempt in 1 2 3; do
  if timeout --kill-after=2s 20s turnutils_uclient -y -c -m 2 -n 10 -p 3478 \
    -u "${test_credentials[0]}" -w "${test_credentials[1]}" 127.0.0.1 2>&1 \
    | python3 -c '
import re
import sys

matches = re.findall(r"tot_send_msgs=(\d+),\s*tot_recv_msgs=(\d+)", sys.stdin.read())
if not matches:
    sys.exit(1)
sent, received = map(int, matches[-1])
sys.exit(0 if sent > 0 and received == sent else 1)
'
  then
    test_ok=true
    break
  fi
  sleep 1
done
unset test_credentials
if [[ "$test_ok" != true ]]; then
  printf 'Verificação local falhou: confira interfaces/relay, rota do IP externo e serviço.\n' >&2
  printf 'O serviço/configuração foram preservados; o teste não validou firewall externo.\n' >&2
  exit 1
fi
printf 'Autenticação efêmera e envio/recebimento de pacotes confirmados.\n'
printf 'UFW manteve seu estado anterior; confirme SSH antes de habilitá-lo se estiver inativo.\n'

# Saída explícita solicitada pelo operador. Não capture/publice esse resumo.
printf '\n============================================================\n'
printf 'TURN CONFIGURADO\n'
printf '============================================================\n'
printf 'SELF_LIVE_TURN_URL=turn:%s:3478?transport=udp\n' "$PUBLIC_IP"
printf 'SELF_LIVE_TURN_SECRET=%s\n' "$TURN_SECRET"
printf '============================================================\n'
printf 'Para ler o segredo depois: sudo cat /etc/turnserver.secret\n'
printf '============================================================\n'
unset TURN_SECRET
