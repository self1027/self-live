# Coturn para o Self Live

O script TURN da VPS `72.61.63.75` prepara somente o transporte de mídia.
Captura e lógica da sala continuam nos peers. O script abaixo prepara Debian/Ubuntu com systemd.

**TURN resolve mídia, não sinalização. Se você está atrás de CGNAT, o WSS do host
da sala também precisa ser alcançável (IPv6 ou signaling relay).** O Self Live
agora tenta PCP/NAT-PMP/UPnP no roteador e mostra o diagnóstico no dashboard, mas
isso não abre a camada de CGNAT da operadora. O signaling relay é provisionado
separadamente; confira [o guia do relay](relay-setup.md) e
[conectividade automática no README](../README.md#conectividade-automática-upnpnat-pmp).

Execute na VPS, a partir de uma cópia do projeto:

```bash
sudo bash scripts/setup-turn.sh
```

O script instala pacotes ausentes, escreve configuração e unidade systemd,
habilita/reinicia `coturn` e verifica relay autenticado local. Na primeira execução
gera 64 caracteres hexadecimais com `openssl rand -hex 32`; nas seguintes reutiliza
o mesmo segredo. Execuções concorrentes são serializadas. Um segredo existente
inválido causa erro, sem substituí-lo silenciosamente.

`/etc/turnserver.secret` pertence a root e tem modo `600`. A configuração também
contém o segredo e usa `root:turnserver`, modo `640`, para o serviço ler sem rodar
como root. O resumo final imprime o segredo conforme solicitado: não publique nem
capture essa saída em logs compartilhados. Para consultá-lo posteriormente:

```bash
sudo cat /etc/turnserver.secret
```

O script substitui `/etc/turnserver.conf` e
`/etc/systemd/system/coturn.service`. Guarde alterações próprias antes de executá-lo
novamente. `use-auth-secret` implementa a autenticação efêmera e já habilita o
mecanismo long-term internamente. A diretiva `lt-cred-mech` foi mantida conforme
o projeto; algumas versões imprimem aviso sobre a redundância. Coturn recente
bloqueia peers loopback por padrão e removeu `no-loopback-peers`: o script usa a
diretiva apenas nas versões que a reconhecem, sem ativar `allow-loopback-peers`.
Veja a [configuração oficial do Coturn](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf).

## Firewall, rede e TLS

Regras UFW: `3478/udp`, `3478/tcp`, `5349/udp`, `5349/tcp` e
`49152:65535/udp`. O script preserva o estado ativo/inativo do firewall. Se UFW
estiver inativo, preserve a porta SSH real antes de habilitá-lo:

```bash
sudo ufw allow 22/tcp comment 'SSH' # ajuste se seu SSH usar outra porta
sudo ufw enable
sudo ufw status
```

Abra as mesmas portas no firewall do provedor. `external-ip=72.61.63.75`
pressupõe esse IP na VPS ou mapeamento de portas 1:1 no provedor. `relay-ip`
é definido explicitamente com um endereço não loopback: o IP público, quando
presente na interface, ou o endereço da rota de saída. Se o servidor
estiver atrás de NAT, adapte para `external-ip=IP_PUBLICO/IP_PRIVADO` e confira
se cada porta de relay conserva seu número, conforme a
[referência do turnserver](https://github.com/coturn/coturn/wiki/turnserver).

Este setup habilita TURN UDP/TCP em **3478**. Só reservar `tls-listening-port=5349`
e abrir o firewall não fornece TLS/DTLS. O script desabilita esses listeners até
haver certificado/chave. Para redes que exigem TURN sobre TLS, provisione um
domínio com certificado confiável, disponibilize `cert`/`pkey` ao grupo `turnserver`,
remova `no-tls`, configure os caminhos no `.conf` e reinicie o serviço. Use
`turns:SEU_DOMINIO:5349?transport=tcp` nos peers. Reexecutar o setup sobrescreve
essa edição; não há emissão/renovação automática de certificado nesta entrega.

## Configurar o peer Windows

No PowerShell do peer, informe o segredo lido da VPS, sem adicioná-lo ao código:

```powershell
$env:SELF_LIVE_TURN_URL = 'turn:72.61.63.75:3478?transport=udp'
$env:SELF_LIVE_TURN_SECRET = 'COLE_O_SEGREDO_DA_VPS'
$env:SELF_LIVE_TURN_TTL = '3600'
npm start
```

TURN é opcional. Sem URL e segredo válidos o app usa STUN. A credencial de cada
nova conexão usa `username = timestamp_de_expiracao:nodeId` e
`base64(HMAC-SHA1(secret, username))`, segundo o
[mecanismo TURN REST API do Coturn](https://github.com/coturn/coturn/blob/master/README.turnserver).
Sincronize relógios da VPS e dos peers. Credenciais novas não renovam conexões
ativas; o segredo permanece no processo main do Electron.

## Verificar localmente e externamente

O pós-check usa `turnutils_uclient -y` apontando para `127.0.0.1:3478`, com duas
allocations que retransmitem pacotes entre si. `-y` dispensa `turnutils_peer`; o
IP loopback é o listener de controle, e não o destino de mídia autorizado.
O `relay-ip` explícito evita alocar mídia em 127.0.0.1 ao usar esse listener.
Se a VPS estiver atrás de NAT do provedor, esse teste também exige que a própria
VPS consiga alcançar suas allocations pelo IP externo (hairpin); falha nesse
cenário exige validar o relay de fora da VPS, além do mapeamento 1:1.
O resultado exige pacotes enviados e recebidos, além de retorno bem-sucedido.
Falha deixa serviço e arquivos disponíveis para diagnóstico e retorna erro;
não libera peers loopback nem considera a porta externa validada. Referência:
[turnutils_uclient](https://github.com/coturn/coturn/wiki/turnutils_uclient).

Para uma verificação externa, gere na VPS credenciais de cinco minutos:

```bash
sudo python3 - <<'PY'
import base64, hashlib, hmac, time
from pathlib import Path
secret = Path('/etc/turnserver.secret').read_text().strip().encode('ascii')
username = f'{int(time.time()) + 300}:trickle-check'
credential = base64.b64encode(hmac.new(secret, username.encode(), hashlib.sha1).digest()).decode()
print('Username:', username)
print('Credential:', credential)
PY
```

Em um PC fora da VPS, abra o
[Trickle ICE oficial do WebRTC](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/),
remova servidores de exemplo e adicione `turn:72.61.63.75:3478?transport=udp`
com esse **Username** e **Credential** temporários. Nunca forneça o segredo
principal ao site. Use a política `relay`, se disponível, e clique em
**Gather candidates**. Deve aparecer um candidato `relay`.

Esse teste confirma autenticação/obtenção de candidato; para confirmar mídia,
execute `npm run test:turn` com URL/segredo no ambiente ou use dois peers com
relay forçado conforme o README. Teste também em redes diferentes. O setup local
não verifica acesso externo nem elimina a necessidade de sinalização WSS
alcançável. UDP 3478 sozinho pode falhar em firewall corporativo; nesses casos,
configure e valide um transporte TCP/TLS permitido pela rede.

## Monitorar

```bash
sudo systemctl --no-pager --lines=0 status coturn
sudo apt-get install vnstat
sudo systemctl enable --now vnstat
sudo vnstat -i eth0 -m
```

Se a interface tiver outro nome, use `ip -brief link` para identificá-la e ajuste
`eth0`. O histórico começa quando vnStat é ativado. `sudo journalctl -u coturn`
mostra eventos do serviço systemd. Os logs nativos do daemon são descartados por
padrão, pois incluem IPs e identidades TURN; a verificação de setup imprime apenas
o resultado agregado. O app registra modo, tipos de candidatos e RTT, sem senha,
SDP, ICE completo ou credenciais TURN.

`total-quota=100` e `user-quota=12` limitam allocations, não Mbps.
`bps-capacity=0` não limita banda. Vários viewers a 6–15 Mbps podem consumir
rapidamente a franquia e a capacidade de entrada/saída da VPS; monitore o plano
do provedor. A ausência do relay afeta conexões que dependem dele.

## Rotacionar o segredo

A rotação derruba o serviço durante o reinício e invalida credenciais derivadas
do segredo anterior. Em uma janela de manutenção:

```bash
sudo rm -f -- /etc/turnserver.secret
sudo bash scripts/setup-turn.sh
sudo cat /etc/turnserver.secret
```

Atualize `SELF_LIVE_TURN_SECRET` em todos os peers e reinicie os aplicativos.
Não versionamos nem distribuímos automaticamente o segredo.

## Desinstalar

Execute somente se Coturn e essas regras pertencem a esta instalação:

```bash
sudo systemctl disable --now coturn
sudo ufw delete allow 3478/udp
sudo ufw delete allow 3478/tcp
sudo ufw delete allow 5349/udp
sudo ufw delete allow 5349/tcp
sudo ufw delete allow 49152:65535/udp
sudo rm -f -- /etc/systemd/system/coturn.service /etc/turnserver.conf /etc/turnserver.secret /run/lock/self-live-turn-setup.lock
sudo systemctl daemon-reload
sudo apt-get purge -y coturn
```

Feche também as portas no firewall do provedor e remova as variáveis TURN dos
peers. UFW e vnStat permanecem disponíveis para outros serviços; não os desative
nem remova indiscriminadamente. Se existirem dados/logs do Coturn em
`/var/lib/turn` e `/var/log`, confira seus conteúdos e elimine apenas os arquivos
que pertencem ao relay desinstalado.

## Privacidade

TURN retransmite pacotes DTLS-SRTP criptografados e não recebe senha da sala,
mensagens WSS nem o segredo de captura. O operador da VPS ainda observa IPs dos
clientes, horários, duração e volume de tráfego. `turn:` usa UDP/TCP sem TLS no
transporte de controle ao relay; `turns:` acrescenta TLS ao transporte, mantendo
a mídia DTLS-SRTP. Uma credencial efêmera concede uso de relay até expirar. Quem
possui o segredo principal pode gerar credenciais arbitrárias: entregue-o
somente aos peers confiáveis e proteja o ambiente do processo main.
