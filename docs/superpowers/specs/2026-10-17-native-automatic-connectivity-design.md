# Conectividade automática do MVP nativo

## Pedido e resultado esperado

O usuário quer receber uma transmissão entre redes diferentes, preferindo mídia
P2P e seguindo os fallbacks da branch `main`. A captura deve continuar em C++.
A interface pode melhorar, com prioridade para clareza e fluidez sob carga de GPU.
Superpowers, Ponytail, UI UX Pro Max e as orientações de redesign do Taste foram
solicitados explicitamente. Este documento registra esse fluxo já discutido.

## Comportamento

- Transmissor inicia a captura e copia um único convite automático. O receptor
  cola o convite no MVP e assiste. Não é necessário preencher campos TURN.
- Sinalização tenta WSS direto por IPv6 global e IPv4 público/mapeado, depois
  relay WSS cifrado e endereços locais, usando as prioridades da `main`.
  Cada tentativa tem prazo de 5 segundos para transporte e handshake juntos.
- TLS direto usa certificado efêmero e fingerprint transportado no convite;
  o token da captura só é enviado depois de verificar o certificado.
- A mídia é negociada por ICE com preferência normal por candidatos diretos,
  STUN e TURN quando disponível, com política `all` por padrão. Usar relay WSS
  para sinalização não significa retransmitir vídeo pela VPS.
- PCP, NAT-PMP e UPnP reutilizam o código da `main`, em segundo plano, com leases
  pertencentes ao processo, renovação e remoção no encerramento. A faixa UDP é
  aplicada ao helper nativo e às janelas receptoras antes de iniciar WebRTC.
- Mapeamentos não são anunciados como conectividade pública quando existe
  indicação de CGNAT. Candidatos adicionais usam somente o endereço/porta que
  realmente correspondem ao socket ICE e ao lease criado pelo processo.
- Falha numa alternativa avança automaticamente à próxima. Cancelar/fechar o
  receptor cancela tentativas, timers e sockets sem interromper outra sessão.
- Convites atuais e legados do MVP são aceitos. Convites da aplicação `main`
  usam outro protocolo e recebem uma mensagem específica, sem tentar tratá-los
  como convites nativos. Convite expirado/antigo não é atribuído a falta de TURN.
- Logs do receptor distinguem validação do convite, tentativa de rota,
  registro no relay, localização do host, handshake e negociação da mídia.
  Não registram tokens, convites, credenciais, SDP, candidatos completos ou IPs.
- Interface e player mostram separadamente o caminho da sinalização e da mídia.
  Campos TURN ficam em opções avançadas. Falhas de sinalização não mandam
  configurar TURN. A configuração de logs é respeitada também ao assistir.

## Limites e decisões de implementação

Continuar em `experiment/native-capture-mvp`; não substituir a `main`.
Windows x64, Electron e HTML/CSS/JS existentes, C++/GStreamer 1.28.8 para captura,
codificação e envio. Não adicionar dependências para recriar recursos existentes.
Vídeo, um espectador por captura, resolução/FPS/bitrate fixos por teste.
Não alterar o caminho de pixels para JS nem introduzir animações contínuas na UI.

TURN continua com o mesmo limite de infraestrutura da `main`: precisa existir
um servidor autenticado configurado. Reaproveitar credenciais locais/ambiente
quando disponíveis e gerar temporárias no main; não inventar um serviço de
credenciais, embutir segredos ou afirmar que TURN está disponível sem validação.
Não implantar serviços externos nesta alteração. Melhorar conectividade direta
e diagnóstico não prova que o problema relatado foi reproduzido em outra rede.

Escolhas delegadas ao implementador: organização visual, tons escuros discretos,
espaçamento, nomes internos e divisão de módulos. Preservar controles de GPU,
logs, resize, fullscreen, minimização e encerramento do helper.

## Interfaces entre tarefas

`createNativeNetwork({servers, udpPorts, env, onUpdate})` produz `start()`,
`endpoints()`, `snapshot()`, `mappedIce(value)` e `closePorts()`. `servers` tem
`wsPort` e `bindings`. `mappedIce` recebe `{candidate,sdpMLineIndex,generation}`
e devolve um novo objeto ICE ou `null`; nunca escreve candidatos em logs.

O helper `connect` aceita `udpMin` e `udpMax`, ambos ausentes ou uma faixa válida.
O main aplica a mesma faixa a `webContents.setWebRTCUDPPortRange` no receptor.

`connection-stage`: `{type,role:'receiver',stage,method?,code?}`. Estágios:
`trying`, `connected`, `failed`, `media-connecting`, `media-connected`, `closed`.
Métodos: `ipv6`, `ipv4-direct`, `ipv4-manual`, `relay`, `ipv4-local`.
`port-mapping`: `{type,status,method?,reason?}`, sem endereços ou credenciais.
Esses eventos chegam ao player e a `nativeMvp.onEvent` no dashboard.

## Aceitação

Testes determinísticos verificam fallback, pin TLS antes do token, cancelamento,
ausência do host, relay indisponível, convites inválidos e dados privados fora
dos logs. Testes reais verificam vídeo codificado por hardware e recebido,
rota direta e fallback de sinalização pelo relay público, reconexão e shutdown.
Capturas de tela verificam layout, foco, overflow e estados de erro.
Entregar portátil separado e documentação. Informar explicitamente qualquer
validação que ainda depende de dois PCs/operadoras ou credenciais TURN reais.
