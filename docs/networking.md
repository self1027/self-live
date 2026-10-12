# Rede, sinalização e mídia

[Voltar ao projeto](../README.md) | [Guias](README.md)

A sinalização encontra os peers e negocia a sessão; WebRTC transporta a mídia.
Relay de sinalização e TURN têm funções independentes. O piloto usa P2P para mídia;
a emissão de credenciais TURN pela VPS permanece pendente.

## Conectividade automática (UPnP/NAT-PMP)

Depois de iniciar os servidores, o main tenta **PCP → NAT-PMP → UPnP** em segundo
plano. Mapeia a porta TCP do WSS e uma faixa de **16 portas UDP** da mídia,
preservando o número de cada porta externa/interna. O HTTP permanece em localhost
e não é mapeado. A captura e a sala podem funcionar enquanto essa descoberta ocorre.

O Chromium usa `setWebRTCUDPPortRange` antes de criar conexões. Mapear uma única
porta UDP não atenderia múltiplos viewers/loopback: os endpoints WebRTC precisam
de sockets distintos. A faixa é escolhida livre por instância; para port forwarding
manual estável, configure a primeira porta e a porta WSS antes de iniciar:

```powershell
$env:SELF_LIVE_WS_PORT = '4000'
$env:SELF_LIVE_MEDIA_PORT = '50000' # faixa UDP 50000–50015
$env:SELF_LIVE_UPNP = 'on'         # padrão
$env:SELF_LIVE_UPNP_TTL = '7200'   # padrão, 1200–86400 segundos
npm start
```

Instâncias simultâneas com porta de mídia explícita precisam de faixas diferentes.
Em `on`, falhas geram aviso e o app continua; `auto` tenta os mesmos protocolos,
mas silencia falhas de mapeamento. Para desabilitar completamente a descoberta
WAN/mapeamento no roteador:

```powershell
$env:SELF_LIVE_UPNP = 'off'
npm start
```

A consulta informativa ipify continua disponível; sem WAN do roteador, IPv4
atrás de NAT pode ficar **Desconhecido**. Bind WSS restrito a loopback também
desabilita o mapeamento. Os leases duram duas horas por padrão e são renovados
dez minutos antes de expirar; leases menores concedidos pelo roteador ajustam
o intervalo. Falha parcial desfaz a tentativa antes de testar outro protocolo.
Uma falha de renovação remove o anúncio de mapeamento do dashboard e atualiza
o link gerado. Copie a versão atualizada antes de compartilhá-la.

Em **Diagnóstico avançado → Conectividade**, confira o método, a porta TCP, a faixa UDP e
o estado da rede. **Como resolver** abre instruções para firewall, UPnP,
port forwarding e IPv6. `window.selfLive.portMapping` fornece o snapshot atual
`{ tcp, udp, method, status }`, atualizado por IPC, sem expor o IP WAN.

`@achingbrain/nat-port-mapper` 4.0.5 fornece NAT-PMP e UPnP **IGD v2**. Como essa
versão não implementa PCP, o projeto inclui um adapter PCP MAP conforme o
[RFC 6887](https://www.rfc-editor.org/rfc/rfc6887). Roteadores somente IGD v1,
UPnP desativado, portas em conflito ou bloqueios da operadora podem exigir IPv6
ou configuração manual. Mapeamento bem-sucedido não prova alcance pela Internet;
CGNAT/NAT duplo continuam exigindo uma rota para o WSS.


## Entendendo seu estado de rede

A consulta IPv4 do ipify é reutilizada e comparada com as interfaces locais e a
WAN informada pelo roteador. O resultado é informativo, não bloqueia a captura.

| Estado | Dashboard | Interpretação e ação |
| --- | --- | --- |
| `public` | 🟢 Pública | IPv4 público na interface ou IPv6 global disponível. Confira rota/firewall e teste de fora. |
| `nat` | 🟡 NAT (UPnP ativo) / 🟠 NAT (sem UPnP) | Saída pública igual à WAN, diferente do IP local. Use o mapeamento automático ou port forwarding. |
| `cgnat` | 🔴 CGNAT / NAT duplo | WAN diferente do IP de saída. Mapeamento no primeiro roteador não abre a camada a montante; solicite IPv6/IPv4 público à operadora. |
| `unknown` | ⚪ Desconhecido | Consulta/WAN indisponível. Confira rede/roteador e valide IPv6 ou port forwarding manual. |

WAN diferente indica NAT a montante; não identifica se é CGNAT da operadora,
um segundo roteador, VPN ou múltiplas rotas. IPv6 global mantém o estado geral
`public`, mas `ipv4Status` ainda pode mostrar CGNAT e o aviso específico de IPv4.
Um endereço global detectado pode estar sem rota ou bloqueado pelo firewall.
O signaling relay opcional na VPS oferece fallback quando o WSS do host não é
alcançável. TURN oferece o caminho de mídia, independentemente da sinalização.


## Link de acesso e alternativas WSS

No host da sala, clique em **Copiar link** e **Copiar senha**. No viewer,
cole em **Link de acesso**, informe a senha e clique em **Entrar**. O convite
contém sala, nome, `node_id`, impressão TLS SHA-256 e endpoints ordenados:

1. IPv6 global (`priority: 1`).
2. IPv4 público direto ou porta TCP mapeada (`priority: 2`).
3. Relay opcional e candidatos IPv4 para port forwarding manual (`priority: 3`).
4. LAN/localhost para testes na mesma rede/máquina (`priority: 4`).

Cada rota é tentada uma vez, com **cinco segundos incluindo o handshake**.
Falha de transporte/certificado tenta a próxima; sala/senha rejeitada interrompe
as tentativas. **Sair** cancela uma entrada em andamento. Se nenhuma responder,
o dashboard oferece diagnóstico. O transporte via relay reconecta com backoff;
o transporte direto mantém o fluxo de entrada existente.

CGNAT conhecido não anuncia IPv4 público como alcançável. Em estado desconhecido,
o IPv4 observado pode aparecer como candidato **manual**, sem garantia de alcance.
Rotas duplicadas são removidas. Um mapeamento só entra no link como direto quando
a WAN também foi validada; firewall e teste remoto continuam necessários.
As variáveis `SELF_LIVE_SIGNAL_URL`/`SELF_LIVE_SIGNAL_FINGERPRINT` continuam úteis
para configuração manual. Peers que importam um convite podem compartilhar o mesmo
convite; um peer configurado somente com URL remota deve obter o link do host.

O formato `self-live://join?data=...` usa JSON em base64url: **não é criptografia**.
O link inclui endereços de rede e não inclui senha nem segredo TURN. Compartilhe-o
por canal privado com a senha enviada separadamente. Nesta fase o link é colado
no dashboard; não há associação do protocolo no Windows. Após reiniciar o host,
gere outro link, pois certificado e portas automáticas podem mudar.
Somente URLs WSS validadas/importadas são liberadas para o Electron; o certificado
precisa corresponder ao pin do destino quando ele é usado. O relay público
valida a cadeia CA e o hostname, sem exigir pin. Logs de tentativas mostram apenas os
primeiros dois octetos IPv4 ou prefixo IPv6, método e porta.


## Arquitetura híbrida (P2P + TURN)

O ICE oferece candidatos diretos junto com os candidatos TURN e prioriza o
caminho direto. Se NAT simétrico, NAT duplo ou firewall impedir esse caminho,
o Coturn da VPS **72.61.63.75** pode retransmitir a mídia. Sem configuração TURN,
o app usa apenas STUN. A captura continua local; o relay WSS da VPS encaminha sinalização cifrada,
sem atuar como SFU ou decodificar mídia. [Referência: TURN no WebRTC](https://webrtc.org/getting-started/turn-server).

A faixa **10–25%** citada no planejamento serve como hipótese inicial para
dimensionar conexões por relay, não como estatística medida do Self Live nem
taxa universal de produção. A proporção depende das redes dos usuários e deve
ser medida com os indicadores de conexão antes de estimar custos.

A sinalização continua WSS entre aplicativos. O host centraliza a lógica da
sala e o signaling relay opcional encaminha pacotes cifrados quando a rota
direta falha; não há malha distribuída. **TURN não torna o WSS acessível por trás
de CGNAT**: use o signaling relay ou uma rota direta para negociar a mídia.

Prepare a VPS com [docs/turn-setup.md](turn-setup.md). O script gera e reutiliza
um segredo aleatório; nenhum segredo foi incluído no projeto. O fluxo abaixo é legado para desenvolvimento com peers confiáveis; não
embuta o segredo mestre no EXE. Configure nos terminais de ambos os peers, além das variáveis da sala/WSS:

```powershell
$env:SELF_LIVE_TURN_URL = 'turn:72.61.63.75:3478?transport=udp'
$env:SELF_LIVE_TURN_SECRET = 'COLE_O_SEGREDO_LIDO_NA_VPS'
$env:SELF_LIVE_TURN_TTL = '3600' # opcional, 60–86400 segundos
npm start
```

Se URL estiver definida sem segredo, há um aviso e TURN é ignorado. TTL inválido
ou URL inválida também voltam a STUN. O segredo fica no main; o preload expõe
somente `generateTurnCredentials(nodeId)`, que invoca `generate-turn-credentials`
e retorna `{ username, credential, urls }`. Cada novo endpoint WebRTC recebe
credenciais com expiração e HMAC-SHA1; conexões ativas não são renovadas/reiniciadas.
Sessões de relay que ultrapassam o TTL precisam de validação específica; não há
política de renovação de credenciais para essas sessões nesta entrega.
Mantenha os relógios dos peers e da VPS sincronizados. Logs ocultam hosts que são
IPs e não imprimem segredo, credenciais, SDP ou candidatos completos.

Para forçar o caminho TURN manualmente, configure nos **dois peers** e reinicie:

```powershell
$env:SELF_LIVE_ICE_TRANSPORT_POLICY = 'relay'
npm start
```

Entre na sala, transmita e assista normalmente. Essa opção aplica
`iceTransportPolicy: 'relay'` ao streamer e ao viewer; o dashboard deve mostrar
**🟡 Relay (TURN)**. Sem TURN acessível, a conexão falha em 15 segundos. Para
voltar à preferência P2P, remova a variável e reinicie:

```powershell
Remove-Item Env:SELF_LIVE_ICE_TRANSPORT_POLICY -ErrorAction SilentlyContinue
```

O teste de mídia local continua negociando SDP/ICE em memória, sem forçar relay;
as conexões recebem a mesma configuração opcional de servidores ICE.
UDP 3478 não atravessa todos os firewalls corporativos. O setup também permite
TURN TCP 3478; TURN TLS 5349 exige domínio e certificado/chave adicionais, conforme
a documentação. Não há tentativas automáticas entre URLs TURN ou reconexão nesta fase.

**Privacidade:** o TURN não recebe senha, sala ou mensagens WSS. A mídia passa
criptografada com DTLS-SRTP, sem ser decodificada pela VPS. O operador do relay
consegue observar IPs, identidade TURN efêmera, horários e volume de tráfego;
TURN não oferece anonimato. Quem recebe o segredo principal no ambiente pode
gerar credenciais arbitrárias: compartilhe-o apenas com peers confiáveis. A
consulta informativa de NAT contata `api.ipify.org`, que vê o IP de saída.
O IP WAN/observado permanece no main para classificação e não aparece nos logs
nem no IPC de estado. O link de acesso pode incluir o endereço público necessário
para alcançar o host; quem recebe o link pode ler esses endereços.
[Referência: segurança WebRTC](https://www.rfc-editor.org/rfc/rfc8827).


## Indicadores de conexão no dashboard

O viewer mostra o caminho realmente selecionado pelo ICE:

- **🟢 Direta (IPv6)**: par direto com endereço IPv6 nas estatísticas.
- **🟢 Direta (P2P)**: par direto host/srflx/prflx, normalmente IPv4.
- **🟡 Relay (TURN)**: candidato relay em pelo menos uma ponta.
- **🔴 Falha**: conexão falhou ou não conectou dentro de 15 segundos; tente
  novamente manualmente. Não há backoff nem reconexão automática.

O RTT é atualizado a cada três segundos: verde abaixo de **100 ms**, amarelo
abaixo de **250 ms**, vermelho a partir de **250 ms**. Sem amostra, aparece `—`.
É o tempo de ida e volta do transporte ICE, não a latência total de vídeo.
O diagnóstico consulta `transport.selectedCandidatePairId` no Chromium e usa
`selected`/`nominated` como alternativas; logs mostram apenas tipos e RTT.
[Referência: WebRTC Stats](https://www.w3.org/TR/webrtc-stats/).

O bloco **Conectividade** mostra a classificação da WAN e os mapeamentos; os
indicadores **Direta/Relay** descrevem a mídia realmente selecionada pelo ICE.
Uma rede com CGNAT pode usar mídia TURN se houver credenciais e alcance ao
servidor. A sinalização pode chegar pelo WSS direto ou pelo relay.


## Encerramento limpo pela bandeja

Ao clicar em **Sair**, o main solicita a limpeza do renderer via IPC. O renderer
para a transmissão, envia `stop_watching` se estiver assistindo, fecha os endpoints
WebRTC/loopback e para todas as tracks. Em seguida envia `goodbye` e fecha o
WebSocket com código 1000. O main aguarda a confirmação, cancela renovações e
remove os mapeamentos antes de fechar WSS/HTTPS/HTTP,
remove o tray e chama `app.exit(0)`.

O `before-quit` também passa por esse fluxo e usa `preventDefault()`. Há um limite
total de três segundos para forçar saída se algum recurso travar; falhas em uma
etapa são registradas e as demais continuam. O servidor remove a presença em
`goodbye` antes de fechar o socket; o `close` posterior não duplica `user_left`.
Um viewer do peer que sai mostra **Streamer desconectado** e limpa seu vídeo.

Os logs no terminal mostram **Parando transmissão**, **Fechando conexões WebRTC**,
**Parando tracks de captura**, **Enviando goodbye**, **Fechando WebSocket**,
**Removendo mapeamentos de portas**, **Fechando servidor WSS local** e
**Encerrando app**. Não registram senha, IP público completo, SDP ou ICE.
Fechar a janela pelo **X** continua apenas escondendo o dashboard na bandeja.
Remoção é best-effort para preservar o limite de três segundos. Se o roteador
não responder a tempo, leases restantes expiram pelo TTL.


## Endpoints IPv6-first

`src/main/network.js` lê `os.networkInterfaces()` e retorna `{ ip, family, iface }`
na ordem: IPv6 global, IPv4 privado, IPv4 público. Ignora interfaces internas,
loopback, IPv6 link-local/ULA, multicast e endereços reservados de documentação.
IPv4 link-local e CGNAT também não são anunciados como endpoints públicos.
Os blocos IPv6 de documentação são excluídos conforme o [registro da IANA](https://www.iana.org/assignments/iana-ipv6-special-registry/).

Em **Diagnóstico avançado**, os endpoints aparecem nessa ordem, com IPv6 global destacado
e o indicador **IPv6 disponível ✅** ou **Apenas IPv4 ⚠️**. URLs IPv6 usam colchetes:
`wss://[ENDERECO_IPV6]:4000`. Os links de acesso tentam IPv6 antes de IPv4;
URL e SHA-256 também podem ser informados manualmente por ambiente.

O WSS usa listeners IPv6-only em `::` e IPv4 em `0.0.0.0` na mesma porta; se o SO
não oferecer IPv6, utiliza IPv4. A presença de um endereço global detectado não
garante acesso externo: rota e firewall ainda precisam permitir a conexão.
Uma restrição explícita em `SELF_LIVE_WS_HOST` prevalece sobre os listeners padrão.


