# Desenvolvimento e testes

[Voltar ao projeto](../README.md) | [Guias](README.md)

Procedimentos para executar o app a partir do código e validar captura,
presença e mídia em instâncias locais. Para distribuir o EXE, use [o piloto](pilot.md).

## Executar

Para o primeiro **piloto fechado P2P**, use [o guia do executável portátil](pilot.md).
`npm run dist:pilot` gera o EXE; configurações são salvas pelo app e a senha local
é protegida pelo armazenamento seguro do Windows. Este piloto usa mídia P2P;
a emissão de credenciais TURN pela VPS permanece pendente.

Instale Node.js 22 LTS ou superior e execute:

```powershell
npm ci
npm run check
npm test
npm start
```

O dashboard abre dentro do Electron. Fechar a janela mantém a captura na bandeja;
use **Sair** para encerrar. Por padrão, o WSS escuta em `::` e `0.0.0.0` na mesma
porta, enquanto o dashboard HTTP permanece em 127.0.0.1. Cada processo usa sua
própria sessão Electron em memória. Portas livres são escolhidas quando não
configuradas; `SELF_LIVE_WS_HOST` ainda permite restringir o bind explicitamente.
No piloto, o mapeamento de portas começa desativado e pode ser habilitado em
**Configurar este PC**. Variáveis de ambiente explícitas continuam prevalecendo;
para manter testes locais sem mapeamento, use `$env:SELF_LIVE_UPNP = 'off'`.
Para desativar o signaling relay nos testes locais, use `$env:SELF_LIVE_RELAY_URL = ''`.


## Validar captura e áudio

1. Crie uma sala e clique em **Quero transmitir**. Escolha a tela/janela,
   resolução e FPS; em **Mais opções**, confira áudio e exclusões.
2. Confirme **Compartilhar** e abra **Diagnóstico avançado** para conferir
   resolução, encoder e conexão. A prévia permanece muda.
3. No diagnóstico, **Teste de mídia local** oferece captura/teste de loopback:
   dois endpoints negociam H.264/Opus na mesma instância. Use fones ao ouvir.
4. Valide também com um viewer em outra instância. Confira som e ausência de
   realimentação; pare o teste/transmissão ao terminar.

O teste local não comprova acesso por outra rede. Para os limites de isolamento
por aplicativo e requisitos Windows, veja [o guia de áudio](application-audio.md).

## Validar handshake

Entre na sala com `self-live-local`. Outra senha deve ser rejeitada. Para alterar
as credenciais de desenvolvimento antes de iniciar:

```powershell
$env:SELF_LIVE_ROOM = 'minha-sala'
$env:SELF_LIVE_PASSWORD = 'minha-senha'
npm start
```

O certificado WSS é efêmero e self-signed. A sessão Electron aceita o certificado
da própria instância e o certificado do host configurado por impressão SHA-256;
não desativa validação TLS globalmente. Hash segue SHA-256(senha + sala).


## Testar dois peers na mesma máquina

As duas instâncias devem conectar ao **mesmo WSS**, o do Peer A. Ter portas
diferentes sem definir esse endereço criaria duas salas independentes.
Não há servidor de mídia: a instância A apenas encaminha sinalização da sala.

No terminal A:

```powershell
$env:SELF_LIVE_HTTP_PORT = '3000'
$env:SELF_LIVE_WS_PORT = '4000'
$env:SELF_LIVE_NAME = 'Peer A'
Remove-Item Env:SELF_LIVE_SIGNAL_URL -ErrorAction SilentlyContinue
Remove-Item Env:SELF_LIVE_SIGNAL_FINGERPRINT -ErrorAction SilentlyContinue
npm start
```

Copie o SHA-256 mostrado no terminal A ou na seção **Diagnóstico avançado** do dashboard.
No terminal B, substitua a impressão de exemplo pela impressão completa copiada:

```powershell
$env:SELF_LIVE_HTTP_PORT = '3001'
$env:SELF_LIVE_WS_PORT = '4001'
$env:SELF_LIVE_NAME = 'Peer B'
$env:SELF_LIVE_SIGNAL_URL = 'wss://127.0.0.1:4000'
$env:SELF_LIVE_SIGNAL_FINGERPRINT = 'COLE_A_IMPRESSAO_SHA256_DO_PEER_A'
npm start
```

1. Entre na sala em ambos os dashboards usando `self-live-local` (ou a mesma
   sala/senha configurada nos dois terminais).
2. No Peer A, clique em **Quero transmitir**, selecione uma tela/janela e confirme **Compartilhar**.
3. No Peer B, clique em **Assistir** ao lado de Peer A. O vídeo aparece na tela de player, com status **Assistindo Peer A**.
4. Use fones e marque **Ouvir áudio P2P** no viewer. O vídeo começa mudo para
   evitar realimentação; o áudio é transmitido mesmo quando o player está mudo.
5. **Parar de Assistir** fecha a conexão do viewer. **Parar Transmissão** encerra
   os envios e a captura do streamer. O alvo rejeita pedidos se não estiver
   transmitindo; o viewer não consegue iniciar captura no outro peer.

O certificado muda ao reiniciar o host; copie a nova impressão e reinicie B.
O relay valida `from` contra o socket autenticado e encaminha `offer`, `answer`,
`ice`, `watch_request`, `stop_watching` e `watch_rejected` para `to`, sem analisar SDP/ICE.
`session_id` identifica cada tentativa e descarta candidatos de conexões antigas.
Candidatos recebidos antes da remote description aguardam em uma fila.


## Testar sala com três instâncias

Use os terminais A/B configurados acima e abra um terceiro terminal para C:

```powershell
$env:SELF_LIVE_HTTP_PORT = '3002'
$env:SELF_LIVE_WS_PORT = '4002'
$env:SELF_LIVE_NAME = 'Peer C'
$env:SELF_LIVE_SIGNAL_URL = 'wss://127.0.0.1:4000'
$env:SELF_LIVE_SIGNAL_FINGERPRINT = 'COLE_A_MESMA_IMPRESSAO_SHA256_DO_PEER_A'
npm start
```

Todos usam a mesma sala e senha. A mantém o relay, mas B também pode transmitir.

1. Entre na sala nas três instâncias. Confira os três nomes em **Usuários**.
2. No B, abra o modal por **Quero transmitir** e confirme **Compartilhar**. A/C devem mostrar B como
   **Transmitindo**, com botão **Assistir**, e seus metadados em **Streams disponíveis**.
3. No A e no C, assista B. São dois viewers simultâneos da mesma captura de B,
   cada um com sua própria `RTCPeerConnection`. Parar um viewer preserva o outro.
4. Inicie uma transmissão no A e, no C, clique em **Assistir** no A. O C envia
   `stop_watching` ao B, encerra a conexão antiga e passa a mostrar **Assistindo Peer A**.
5. Pare a transmissão do B. C continua assistindo A. Se A ainda estava assistindo
   B, A mostra **Streamer parou de transmitir** e encerra apenas seu receiver.
6. Reinicie B, faça C assistir B e pare B novamente. C deve mostrar
   **Streamer parou de transmitir**, limpar o vídeo e remover B dos streams disponíveis.
7. Reinicie B e assista com A/C. Encerre o aplicativo C pelo menu **Sair** da
   bandeja. A/B removem C da presença; B fecha só a conexão de C e continua enviando a A.

Fechar somente a janela esconde o dashboard na bandeja e mantém o peer na sala.
Use **Sair** para encerrar o processo, ou **Sair** no formulário da sala para
fechar o WebSocket mantendo o aplicativo aberto.

`user_joined` é enviado aos outros peers; `welcome` já inclui o próprio usuário,
os demais peers e os streams ativos para quem entra depois. `user_left` limpa a
presença. O streamer anuncia `stream_started`/`stream_stopped`; a sala autentica
`node_id`, guarda `stream_id` e metadados e faz broadcast a todos. Sair da sala
também remove o stream ativo. Um stop atrasado não remove uma transmissão nova.


## Testar na LAN

O Peer A já escuta em IPv6 e IPv4 por padrão. Para remover uma restrição antiga,
execute `Remove-Item Env:SELF_LIVE_WS_HOST -ErrorAction SilentlyContinue` antes de iniciar.
No Peer B, use um endpoint detectado no dashboard de A, por exemplo
`wss://IP_LAN_DO_PEER_A:4000`, e a impressão SHA-256 do Peer A.
O dashboard continua restrito a localhost. Permita o Electron/WSS na rede privada
no Firewall do Windows, incluindo a porta TCP configurada e a faixa WebRTC UDP
mostrada no dashboard.
STUN público: `stun:stun.l.google.com:19302`. TURN é opcional, conforme a seção
[de rede e TURN](networking.md#arquitetura-híbrida-p2p--turn). Mapeamento no roteador
não substitui uma regra no firewall do computador.


## Verificação automatizada

Logs são opcionais e começam desativados. Ative-os na página inicial antes de
transmitir. Veja [como auditar o CS sob carga](stream-audit.md). O adaptive
pode alterar a qualidade; desligue-o para comparar experimentos manuais.

```powershell
npm run check
npm test
npm run test:p2p
npm run test:room
npm run test:turn
npm run test:upnp
```

`test:p2p` abre dois processos Electron com janelas ocultas, usa os botões reais
do dashboard e passa canvas animado + tom de áudio pelo relay WSS e WebRTC.
Confere vídeo decodificado em H.264, áudio recebido em Opus e limpeza ao parar
o viewer. Não captura sua área de trabalho. Esse teste usa mídia sintética
640×360/30fps; captura WASAPI, qualidade audível, 1080p60 e rede LAN precisam ser
validados manualmente com os passos acima.

`test:room` abre três processos Electron com portas livres diferentes e janelas
ocultas. Usa o dashboard real com canvas/tom para validar presença, snapshot de
stream ativo para entrada tardia, dois viewers simultâneos, parada de um viewer,
troca B→A, stop do streamer atual e de outro streamer e saída de C. Confere mídia
H.264/Opus e encerramento das conexões antigas. Nenhum desses testes captura sua
área de trabalho. Logs de falhas incluem peer, sessão e estados WebRTC/ICE,
sem imprimir senha ou SDP.

Esse teste também executa a ação real **Sair** do menu da bandeja de um viewer e
de um streamer ativo. Confere a mensagem **Streamer desconectado**, as etapas de
shutdown, a permanência do processo após fechar a janela com X, o indicador de
rede e a saída de todos os PIDs Electron do teste. Valida também geração/importação
de convite, fallback WSS real após endpoint local indisponível, atualização de
`portMapping`/CGNAT por IPC e uso efetivo da faixa UDP do Chromium.
`npm test` cobre classificação
de endereços, WSS IPv4/IPv6, `goodbye`, fechamento 1000, confirmação IPC e timeout.

`test:turn` valida o vetor HMAC-SHA1/base64 com segredo fictício `abc`, expiração
e validação de configuração. Se URL e segredo estiverem definidos, abre Electron
oculto e negocia dois endpoints locais com política `relay`, verificando o par
selecionado em ambos e uma troca de dados pelo TURN. Sem ambiente configurado ou
sem candidatos relay por indisponibilidade, marca a integração como `skip`.
Obter relay e depois falhar na negociação/validação causa falha do teste.
Não captura a área de trabalho. O teste real da VPS depende da instalação Coturn
e das variáveis no ambiente; o setup Linux não foi executado nesta máquina Windows.

`test:upnp` valida PCP/NAT-PMP/UPnP com mocks, rollback, conflito, timeout,
renovação de TTL, classificação de NAT, links, fallback WSS e faixa UDP.
Por padrão não modifica o roteador. Para testar mapeamentos reais e removê-los
ao final, habilite explicitamente:

```powershell
$env:SELF_LIVE_TEST_UPNP = '1'
npm run test:upnp
Remove-Item Env:SELF_LIVE_TEST_UPNP -ErrorAction SilentlyContinue
```

Sem opt-in ou com roteador incompatível, a integração é `skip`. Este teste
verifica criação/limpeza de leases, não prova que a porta seja alcançável de outra
rede. Nesta entrega, o teste real de roteador e o acesso remoto continuam pendentes.


