# MVP de captura C++

Experimento separado da aplicação principal para comparar fluidez com a GPU
ocupada por um jogo. A referência anterior ao experimento está no commit
[`037794e`](https://github.com/self1027/self-live/commit/037794e).

## Executar

Abra `dist/native-mvp-automatic/Self-Live-Native-MVP-0.1.0-x64-automatic.exe`.
O portátil inclui o motor nativo e o runtime. Para redes diferentes, execute o
MVP nos dois PCs; na mesma LAN, o espectador também pode usar Chrome ou Edge.
O MVP tem dados/configuração próprios e fecha a transmissão ao fechar a janela
principal. O executável anterior permanece disponível para comparação.

1. Abra/restaure a janela do jogo.
2. Selecione a janela, a GPU e 1080p/60 ou 720p/60. A captura preserva proporções,
   respeita o limite de 1920 × 1080 e não amplia fontes menores.
3. Mantenha **Gravar logs de captura e recepção** ligado e clique em **Iniciar captura**.
4. Copie o **Convite automático** e envie-o ao espectador. No outro PC, cole em
   **Receber uma transmissão** e clique em **Assistir**. Não é necessário
   preencher TURN para tentar as rotas disponíveis. Para a mesma LAN, o link
   **Rede local** também abre no navegador.
   **Abrir neste PC** também funciona, acrescentando decodificação no transmissor.
5. Para outra tentativa, pare a captura, altere os parâmetros e inicie novamente.
   Cada início gera um convite novo; o antigo perde a validade.

O primeiro recorte é a **área cliente** da janela. A barra de título e as bordas
padrão do Windows são removidas em C++, antes da conversão/codificação. Controles
desenhados pelo próprio aplicativo dentro da área cliente continuam sendo parte
do conteúdo. O recorte é recalculado com coordenadas físicas a cada frame.

Este MVP tem **somente vídeo e um espectador**, com P2P pela internet ou LAN.
Não inclui áudio, captura de monitor, game hook nem adaptive. O convite autoriza
assistir à captura atual e não dá acesso aos controles do host. O player informa
**P2P direto** ou **via TURN**, a partir do par ICE realmente selecionado.

Se o Windows solicitar acesso à rede, permita o acesso na rede em que fará o
teste. O MVP tenta mapear portas no roteador por PCP, NAT-PMP e UPnP, como a
`main`, com renovação e remoção dos leases ao encerrar. Não altera regras do
firewall do Windows. CGNAT e políticas do roteador podem impedir o mapeamento.

## Conexão automática

O convite contém as alternativas disponíveis no momento da cópia. O receptor
tenta sinalização WSS por IPv6 global, IPv4 público/mapeado, relay público e
endereços locais, seguindo as prioridades da `main`. Cada tentativa dispõe de
cinco segundos para conectar e concluir o handshake. Uma falha avança para a
próxima rota; autenticação inválida e transmissor ocupado encerram a tentativa.
O token só é enviado ao WSS direto depois de verificar o certificado pelo
fingerprint do convite. O navegador recebe apenas uma ponte de loopback local.

A faixa UDP é aplicada ao helper C++ e ao WebRTC do receptor antes da negociação.
Candidatos de mapeamento usam apenas sockets e leases reais do processo, sem
anunciar endereços públicos quando a observação da rede indica CGNAT. A captura
e a codificação continuam no caminho nativo, sem processamento de pixels em JS.

**Sinalização** e **Mídia** têm indicadores separados: usar o relay WSS para
encontrar o transmissor permite manter o vídeo P2P. O relay não é um servidor
TURN. Convites antigos do MVP continuam aceitos; convites da aplicação `main`
usam outro protocolo e recebem uma mensagem específica. Use o novo portátil
nos dois PCs e um convite da captura atual para testar esta versão.

## Internet, STUN e TURN

O relay de sinalização padrão é `wss://relay.murilod.dev:8443`. Cada captura cria
uma sala aleatória própria. SDP, candidatos ICE, configuração de conexão e
estatísticas trafegam cifrados ponta a ponta, usando o mesmo cliente AES-GCM do
projeto principal. O convite contém a capacidade de acesso e expira em 24 horas;
parar/reiniciar a captura invalida o convite anterior. Não publique o convite.
O sinalizador não transporta vídeo.

O helper C++ e o espectador usam `stun:stun.l.google.com:19302` para descobrir
candidatos públicos. ICE pode selecionar uma rota IPv4 ou IPv6. Redes com NAT
restritivo ou bloqueio de UDP podem exigir TURN: STUN sozinho não garante
conectividade em qualquer combinação de redes.

Quando houver um serviço TURN, no **transmissor**, abra **Opções avançadas de
rede · TURN opcional** e escolha a autenticação:

- **Segredo do Coturn · gerar credenciais automaticamente**: para o administrador
  da VPS, informe URL e o mesmo segredo `SELF_LIVE_TURN_SECRET` usado na aplicação
  principal. O MVP usa o gerador da `main` para criar credenciais temporárias
  distintas, válidas por uma hora, para cada peer. O segredo fica no processo
  main e não é enviado ao espectador, helper C++ ou relay.
- **Usuário e credencial TURN**: informe as credenciais de cliente fornecidas
  pelo administrador. Não cole o segredo mestre nesse campo.

Salve antes de capturar. Os dados sensíveis são protegidos com `safeStorage` no
perfil Windows, em `native-network.json`, e não entram no executável ou nos
logs. Deixar o campo de segredo/credencial vazio preserva o valor já salvo,
desde que servidor, modo e usuário não mudem. **Limpar TURN** remove-o. O modo
segredo é configuração local do administrador; não distribua esse segredo aos
outros PCs. Credenciais temporárias não renovam uma sessão ativa automaticamente.

O host envia ao espectador a configuração TURN necessária pela sinalização
cifrada. **Forçar TURN para testar** usa `iceTransportPolicy: relay` nos dois
peers; o app recusa esse modo sem TURN configurado. Use o indicador do player e
`receiver-sample.transport.mode` para confirmar a rota efetiva. `turn:` aceita
UDP/TCP e `turns:` aceita TLS/TCP, conforme o serviço disponibilizado. O portátil
inclui o módulo TLS do GIO e o conjunto de certificados do SDK.

Alternativas de configuração por ambiente, somente no transmissor:

- `SELF_LIVE_TURN_URL`, `SELF_LIVE_TURN_USERNAME` e `SELF_LIVE_TURN_CREDENTIAL`
  fornecem uma credencial TURN de cliente.
- O fluxo existente `SELF_LIVE_TURN_URL` + `SELF_LIVE_TURN_SECRET` gera credenciais
  efêmeras distintas para os peers, como o modo segredo da interface. O segredo
  fica no main e nunca é enviado ao espectador. Isso é configuração de administrador; não distribua o segredo
  mestre nem o inclua no portátil.
- `SELF_LIVE_RELAY_URL` e, para relay privado, `SELF_LIVE_RELAY_FINGERPRINT`
  substituem o sinalizador padrão. Valor vazio de URL desabilita essa alternativa;
  convites com rotas diretas continuam possíveis. TLS exige CA válida ou o pin
  explícito recebido no convite.
- `SELF_LIVE_UPNP=off` desabilita o mapeamento de portas; a descoberta de rotas
  e os demais caminhos continuam disponíveis.

Credenciais TURN não vêm pré-configuradas. O servidor de sinalização existente
não emite credenciais TURN. Consulte [o guia Coturn](turn-setup.md) para a
infraestrutura e a emissão de credenciais temporárias.

O botão **Reconectar** refaz a conexão do espectador sem reiniciar a captura.
Quedas breves do sinalizador conservam o peer por até 90 segundos e permitem
reenvio dos dados de negociação, sem repetir respostas/candidatos já aplicados.
Vídeo já negociado pode continuar durante a indisponibilidade da sinalização.

## Comparação sob carga

Use o mesmo jogo/cena, GPU, resolução, FPS e bitrate nas duas implementações.
Comece sem prioridade de GPU, mantenha o espectador no outro PC e registre
alguns minutos com a janela em foco. Repita com **usar prioridade de gpu**, depois
com 720p/60. Faça Alt+Tab, minimize e restaure durante uma tentativa separada.
Conserve os logs de cada cenário e observe também o desempenho do jogo.

As filas são limitadas e descartam frames antigos. Isso limita o acúmulo de
trabalho, mas não cria capacidade de GPU nem garante 60 fps sob saturação. A
qualidade permanece fixa durante uma tentativa. O tamanho de saída é definido
no início; se o aspecto da área cliente mudar depois, o processamento preserva
as proporções usando barras no quadro de saída.

Minimizar mantém a captura e a conexão. Se a fonte parar de produzir frames,
o último frame é repetido aproximadamente uma vez por segundo como manutenção
da sessão. Esse contador é separado dos frames novos. Ao restaurar a janela,
os frames novos retomam na mesma conexão. Fechar a janela encerra a captura.

## Caminho de vídeo

`WGC em C++ → textura D3D11 → recorte/cópia na GPU → conversão/resize D3D11
→ H.264 por hardware → RTP/WebRTC nativo → espectador`

- `native/mvp/wgc-capture.*`: enumeração Win32, seleção de GPU, WGC com pool
  free-threaded, mailbox de um frame e recorte da área cliente.
- `native/mvp/main.cpp`: quatro slots de textura reutilizados, appsrc limitado a
  um buffer, fila de um frame com descarte do mais antigo, configuração de baixa
  latência, negociação WebRTC e contadores por etapa.
- `native/mvp/gpu-load.h`: PDH em thread separada, limitado ao LUID da GPU
  selecionada. Um contador ausente é `null`, não 0%.
- `src/native-mvp`: interface Electron, comandos por pipe, sinalização de um
  espectador, convite temporário e gravação dos diagnósticos.

Seleção do encoder: AMF para AMD, NVENC em modo D3D11 para NVIDIA e QSV para
Intel. A escolha exige correspondência do LUID da GPU com o encoder. Não existe
fallback para encoder de CPU. O teste real desta máquina validou **RX 7900 XT +
AMF**; os demais caminhos dependem de validação em hardware correspondente.

Os módulos de captura são C++. JavaScript não chama `getDisplayMedia`, não
captura imagens e não transporta frames brutos; ele controla o helper e troca
SDP/ICE. As bibliotecas multimídia são binários nativos GStreamer dinamicamente
ligados. Há uma cópia explícita entre texturas GPU para liberar o frame WGC
antes que o encoder termine; este experimento não promete zero-copy.

## Logs

Use **Abrir logs**. Diretório: `Documentos/SelfLive-NativeMVP-Logs`;
arquivos `native-mvp-*.jsonl`, partes de até 10 MiB. O MVP não remove logs antigos.
O checkbox controla também os logs locais do receptor, inclusive erros antes de
receber vídeo. `start.role` distingue `sender` de `receiver`.

- `start`: configuração, encoder, GPU e LUID; não inclui título/handle da janela.
- `sample`: frames WGC recebidos, submetidos e codificados; FPS por etapa;
  descartes da mailbox/pool; frames de manutenção; estado da janela; prioridade
  GPU consultada novamente a cada amostra; utilização dos engines da GPU escolhida.
- `submitToEncodedP95Ms`: percentil 95 entre a submissão e o buffer H.264 pronto.
  Inclui espera, conversão e encoder; não é tempo puro de execução na GPU.
- `encoderStageP95Ms`: da entrada na etapa do encoder à sua saída, também
  incluindo esperas. A correlação usa running-time dos segmentos e tolera a
  quantização de timestamps do AMF. `latencySamples: 0` resulta em `null`.
- `encodedGapP95Ms`: espaçamento dos buffers codificados.
- `receiver-sample`: FPS decodificado/apresentado, freezes, descarte, jitter,
  bitrate e espaçamento dos frames apresentados, informados pelo espectador.
  `visible` permite identificar medições em abas em segundo plano. `transport`
  informa rota direta/TURN, tipos dos candidatos, protocolo e RTT sem endereços.
- `ice-candidates`: contagem por tipo `host`, `srflx`, `prflx`, `relay` do helper
  nativo, sem registrar os candidatos ou IPs.
- `peer-state` e `signaling-status`: estados de mídia e sinalização separados.
- `connection-stage`: rota tentada, registro no relay, localização do host,
  handshake e início da mídia. Códigos seguros distinguem `dns_failed`,
  `tls_failed`, `tls_pin_mismatch`, `relay_unavailable`, `host_unavailable`,
  `handshake_timeout`, `incompatible_invitation` e `expired_invitation`.
  Falha ao localizar o transmissor não comprova falta de TURN.
- `port-mapping`: estado, método e motivo do mapeamento, sem endereços ou portas.
- `source-resize`, conexão/desconexão e encerramento completam a sequência.

`explicitCpuReadbacks: 0` conta somente operações explícitas do nosso código;
não comprova ausência de cópias internas no driver ou nas bibliotecas. FPS de
frames WGC não mede sozinho fluidez percebida; compare com os dados recebidos.
Títulos de janelas, pixels, SDP, candidatos ICE e tokens de convite não são gravados.

## Compilar

Requisitos: Windows x64 com WGC (Windows 10 1903+), Node.js 22+, Visual Studio
Build Tools com C++/Windows SDK e driver com encoder H.264 de hardware.

```powershell
npm ci
npm run setup:native-mvp
npm run build:native-mvp
npm run start:native-mvp
```

O setup baixa o SDK oficial GStreamer 1.28.8 MSVC x64, verifica SHA-256 e usa
`/portable=1` em `.native-deps/gstreamer`. Não altera PATH, registro ou templates
do Visual Studio. `.native-deps` e `native/bin` não são versionados.

```powershell
npm run check
npm test
npm run test:native-mvp
npm run test:native-automatic
npm run test:native-internet
npm run test:native-internet:public
npm run test:native-turn-settings
npm run dist:native-mvp
```

O smoke usa uma janela Win32 em movimento, captura WGC real e o espectador de
produção. Confere recorte da área cliente no vídeo decodificado, minimizar e
restaurar, resize, reconexão e encerramento do helper. Não usa captura simulada
do Chromium. É validação funcional; desempenho em jogo sob saturação exige o
teste comparativo descrito acima.

O teste de internet usa duas instâncias e sinalização por relay TLS. O comando
`test:native-automatic` verifica seleção de rotas, a interface, logs de recepção
e vídeo real por WSS direto. `test:native-internet:public` injeta uma rota direta
com certificado incorreto e verifica o fallback automático para o WSS público,
decodificação real, candidatos STUN e reconexão do player. Os smokes desabilitam
mapeamento no roteador para serem repetíveis; leases e CGNAT têm testes
determinísticos separados. Os dois processos de vídeo rodam nesta máquina; isso não
substitui testar dois PCs atrás de NATs/operadoras diferentes. O fallback de
mídia TURN precisa de credenciais válidas para um teste efetivo; somente
configurar uma URL não comprova que o relay de mídia está funcionando.

O teste de configuração TURN exercita a interface real nos dois modos,
criptografia do Windows, reinício com o segredo salvo, preservação de campos
ocultos e remoção. Usa um segredo de teste e não acessa o Coturn da VPS.

O empacotamento copia o conjunto necessário de plugins e suas importações PE,
o scanner e os avisos do SDK. Não exige instalação global do GStreamer. O modo
normal continua disponível com `npm start` e seu empacotamento original.

Fontes das APIs: [captura Windows](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.createfreethreaded),
[D3D11](https://gstreamer.freedesktop.org/documentation/d3d11/),
[AMF](https://gstreamer.freedesktop.org/documentation/amfcodec/amfh264enc.html),
[NVENC](https://gstreamer.freedesktop.org/documentation/nvcodec/nvd3d11h264enc.html),
[WebRTC](https://gstreamer.freedesktop.org/documentation/webrtc/).
