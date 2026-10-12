# Sinalização via relay

O WSS local continua ativo. O host registra simultaneamente um transporte adicional na VPS; viewers tentam os endpoints do convite por prioridade, com 5 segundos para conexão **e handshake** em cada endereço. IPv6 e IPv4 direto vêm antes do relay, que vem antes da LAN. Uma rejeição de sala/senha encerra a entrada. O relay não participa do transporte de mídia: WebRTC continua P2P, com TURN como fallback independente.

## Provisionar na VPS

Copie o projeto (incluindo `relay/server.js`, `relay/package.json`, `relay/package-lock.json` e `scripts/setup-relay.sh`) para a VPS Debian/Ubuntu. Execute:

```bash
sudo bash scripts/setup-relay.sh
```

O script usa `flock`, instala Node.js 22 via NodeSource se ausente/incompatível, instala a versão de `ws` fixada no lockfile, cria o usuário de sistema `self-live-relay`, arquivos em `/opt/self-live-relay`, configuração em `/etc/self-live-relay/config.json`, TLS e serviço systemd. Abre `8443/tcp` no UFW sem habilitar o firewall ou mudar SSH. Não altera Coturn nem `setup-turn.sh`. Libere também 8443 no firewall externo da VPS. Só aceita HTTPS/WSS, nunca WS sem TLS.

Sem domínio, gera certificado self-signed de 365 dias com SAN `IP:72.61.63.75`; execuções seguintes preservam o certificado e a configuração. O script mostra o fingerprint e verifica `/health` local com HTTP 200.

Para certificado público, aponte o DNS à VPS e disponibilize a porta 80 para o desafio ACME standalone:

```bash
sudo SELF_LIVE_RELAY_DOMAIN=relay.seudominio.com bash scripts/setup-relay.sh
```

Certbot usa a lineage `self-live-relay`, habilita `certbot.timer` e instala um deploy hook que copia o certificado renovado com permissões restritas e reinicia apenas o relay. Se outro serviço ocupar a porta 80, obtenha o certificado por seu fluxo ACME e instale a chave/cadeia nos caminhos de TLS antes de iniciar o serviço. Referências: [NodeSource](https://github.com/nodesource/distributions), [Certbot standalone e renovação](https://eff-certbot.readthedocs.io/en/stable/using.html).

## Ler o SHA-256

```bash
sudo openssl x509 -in /etc/self-live-relay/tls/cert.pem -noout -fingerprint -sha256
```

Copie somente o valor hexadecimal, com ou sem `:`. Transmita esse pin por um canal confiável.

## Configurar peers

No PowerShell, antes de iniciar o host:

```powershell
$env:SELF_LIVE_RELAY_URL = 'wss://72.61.63.75:8443'
$env:SELF_LIVE_RELAY_FINGERPRINT = 'AA:BB:...:FF' # substitua pelo fingerprint completo
# Opcional: namespace do relay, sem mudar o nome da sala local
$env:SELF_LIVE_RELAY_ROOM = 'sala-x'
npm start
```

`SELF_LIVE_RELAY_URL` ausente usa `wss://72.61.63.75:8443`; valor vazio desativa o relay. `SELF_LIVE_RELAY_ROOM` ausente usa o nome da sala local. Self-signed exige `SELF_LIVE_RELAY_FINGERPRINT`. Sem pin, o cliente exige um certificado público válido para a URL, sem desativar a verificação TLS. Pin configurado é comparado antes de transmitir o registro. Relay sem resposta gera aviso e reconecta em 1, 2, 4, 8, 16 e 30 segundos, com teto de 30 segundos; o WSS local continua funcionando.

Gere o convite no dashboard. O formato `self-live://join?data=...` permanece: o endpoint adicional contém URL, prioridade 3, token da sala, identidade de transporte do host e pin próprio (se configurado). Viewers importam o convite e informam a mesma senha; não precisam copiar a configuração do host para o ambiente. O pin do relay é independente do pin do WSS local. Convites antigos continuam aceitos. O link não contém senha nem chave de cifragem.

## Transporte e privacidade

O registro usa `SHA-256(senha + sala local)` como autenticador. Para satisfazer a privacidade, o campo `room` enviado ao relay é `SHA-256("self-live-relay-room\0" + namespace)`, e todos os pacotes do protocolo local (incluindo hello, presença, streams, SDP e ICE) são cifrados com AES-256-GCM. A chave é derivada por scrypt da senha e da sala local, com domínio separado; **não** é o hash que o relay recebe. O envelope externo contém somente tipo de roteamento, remetente, destinatário e corpo cifrado. Não se tenta cifrar SDP/ICE com o próprio `password_hash`, pois isso permitiria ao relay decifrá-los.

O host usa uma identidade de transporte adicional; sockets virtuais injetam as mensagens decifradas no mesmo fluxo de autenticação e roteamento do WSS local. Assim, viewers diretos e via relay compartilham presença e streams. O relay só acessa os campos externos `type`, `from`, `to`. Uma queda breve preserva os peers virtuais por até 90 segundos e não fecha PeerMedia; reconexão reenvia o hello cifrado e recebe novo snapshot. Depois desse prazo, peers ausentes são removidos. Uma saída voluntária envia goodbye sem aguardar esse prazo.

**Privacidade:** o relay observa IPs dos clientes, identificadores de transporte, token da sala, hash de autenticação, horários, duração e volume de sinalização. Não recebe senha em texto puro, nome da sala em texto puro, SDP/ICE decifrados ou mídia. Logs usam identificadores resumidos por hash e nunca registram IP completo, `node_id` completo, autenticador ou payload. O operador ainda pode correlacionar conexões. Tokens determinísticos e o hash de senha permitem tentativas de adivinhação offline: use senha longa e aleatória e nomes de sala imprevisíveis. A cifragem não esconde esses metadados nem torna senhas fracas resistentes a dicionário. O primeiro registro define as credenciais da sala em memória; não há reserva permanente de namespace.

## Monitorar

```bash
curl --cacert /etc/self-live-relay/tls/cert.pem https://72.61.63.75:8443/health
sudo systemctl status self-live-relay
sudo journalctl -u self-live-relay -f
```

Com domínio, use `https://relay.seudominio.com:8443/health` com a CA pública. Resposta: `{"status":"ok","rooms":0,"peers":0,"uptime":123}`. Salas e peers vivem só em memória; health conta conexões ao relay, não peers que usam apenas WSS local.

O serviço limita 100 mensagens/segundo por conexão (incluindo registro), mensagens a 256 KiB, 10 salas simultâneas por IP, 30 peers por sala e 1000 salas por padrão. Peers sem registro são fechados após 5 segundos. Após 60 segundos sem mensagem, envia ping; sem pong em 5 segundos, encerra a conexão. O limite de peers inclui a identidade de transporte do host.

No dashboard, “Sinalização” e “Mídia” são independentes. “Via relay” pode coexistir com “Direta (P2P)” e “Direta (host)” com “Relay (TURN)”. O aviso sobre alcance direto é uma estimativa do diagnóstico local: IPv6/mapeamento não comprovam que o firewall permite acesso externo.

## Rotacionar certificado

Para self-signed, gere um novo par em arquivos temporários:

```bash
sudo openssl req -x509 -newkey rsa:3072 -sha256 -days 365 -nodes \
  -subj '/CN=Self Live signaling relay' -addext 'subjectAltName=IP:72.61.63.75' \
  -keyout /etc/self-live-relay/tls/key.next.pem -out /etc/self-live-relay/tls/cert.next.pem
sudo install -o root -g self-live-relay -m 0640 /etc/self-live-relay/tls/key.next.pem /etc/self-live-relay/tls/key.pem
sudo install -o root -g self-live-relay -m 0640 /etc/self-live-relay/tls/cert.next.pem /etc/self-live-relay/tls/cert.pem
sudo rm /etc/self-live-relay/tls/key.next.pem /etc/self-live-relay/tls/cert.next.pem
sudo systemctl restart self-live-relay
```

Leia o novo SHA-256, atualize o pin nos hosts, reinicie-os e gere novos convites. O cliente recusa o certificado anterior/incompatível; mídia já conectada continua independente durante a troca breve. Com Let's Encrypt, `sudo certbot renew` executa o hook quando houver renovação. Pins explícitos também mudam em cada renovação; para renovação automática transparente, use URL de domínio com cadeia pública validada e deixe o pin vazio.

## Desinstalar

```bash
sudo systemctl disable --now self-live-relay.service
sudo rm -f /etc/systemd/system/self-live-relay.service
sudo systemctl daemon-reload
sudo ufw delete allow 8443/tcp
sudo rm -f /etc/letsencrypt/renewal-hooks/deploy/self-live-relay
sudo rm -rf /opt/self-live-relay /etc/self-live-relay
sudo userdel self-live-relay
sudo groupdel self-live-relay
```

Se usou Certbot, exclua apenas a lineage própria com `sudo certbot delete --cert-name self-live-relay` e remova a regra ACME de porta 80 caso não seja usada por outros serviços. Preserve Node, Certbot, seu timer, demais certificados e Coturn se usados por outras aplicações. Nos peers, defina `SELF_LIVE_RELAY_URL` vazio e gere novos convites.

## Verificação local

```bash
npm test
npm run check
npm run test:relay
npm run test:fallback
```

Os runners criam relay TLS efêmero e dois processos Electron usando o dashboard/preload reais. Validam H.264/Opus, mídia P2P, estado “Via relay”, reinício do relay, backoff e continuidade dos frames. `test:fallback` direciona um endpoint sintético somente na fixture a um listener HTTPS local que nunca completa o upgrade, exercitando o timeout real de 5 segundos sem acessar a VPS. Captura usa canvas/tom; os testes não alteram roteador nem dependem de TURN.
