# Isolamento de chamadas no compartilhamento de áudio

Nota: o estado do código abaixo corresponde ao levantamento anterior à implementação.
Seleção múltipla e exclusões foram implementadas depois; veja [o guia atual](application-audio.md).

Levantamento em 12/10/2026. Escopo: Self Live/Electron no Windows. Este documento
propõe evolução; não ativa um modo novo de captura.

## Cenário e estado atual

A ouve B no aplicativo de chamada. Capturar a saída geral do computador envia essa
voz de volta a B pela transmissão, com atraso. É necessário excluir essa origem
antes de formar a track Opus. Mutar o player em B também elimina o som desejado.

O código atual já separa vídeo e áudio: `capture.js` entrega apenas vídeo;
`webrtc.js` pede `audio: false`; `application-audio.js` seleciona uma janela; o helper
`native/app-audio.cpp` captura sua árvore de processos. Para tela inteira, há um
seletor de um aplicativo de áudio, com padrão sem áudio. Não existe modo atual
“todos os sons exceto chamadas”. A lista de aplicativos bloqueados impede escolher
fontes conhecidas de chamadas, mas não reconhece chamadas arbitrárias.

Se o EXE novo compartilhar a tela com áudio de um jogo independente e ainda enviar
a chamada, investigar versão do executável, aplicativo selecionado, chamada dentro
do jogo e roteadores/mixadores virtuais que reintroduzam a voz na origem capturada.
Essa é uma hipótese de diagnóstico, não uma reprodução do problema com Discord.

## Evidências de outros produtos

| Produto | Evidência pública | Aplicação ao Self Live |
| --- | --- | --- |
| Discord | A engenharia documenta APIs de áudio do SO e captura do processo compartilhado mais seus filhos. O guia diferencia áudio do aplicativo e áudio geral ao compartilhar toda a tela. | A captura atual segue o mesmo princípio por processo; as fontes consultadas não comprovam uma exclusão universal de chamadas externas. |
| Teams | O suporte descreve compartilhar áudio do computador, incluindo notificações; na web, uma aba pode fornecer somente seu próprio áudio. | Separar a seleção de vídeo da origem de áudio; não presumir que há uma API pública usada pelo Teams para excluir qualquer chamada. |
| Zoom | Oferece compartilhamento do som do computador e documenta cuidados com áudio duplicado/feedback. | Bom modelo de controles separados; os detalhes internos de exclusão de chamadas não estão documentados nas fontes consultadas. |
| OBS | Oferece fontes de áudio por aplicativo e orienta desativar Desktop Audio ao usá-las. | Referência direta para seleção de um ou vários aplicativos, sem captura geral paralela. |
| Curse/Twitch Desktop | A Twitch documentou chamadas de voz/vídeo e informa que o aplicativo foi descontinuado em 30/04/2022. Não encontrei descrição técnica pública verificável do isolamento de áudio do Curse. | Não basear nossa implementação em um mecanismo presumido desse cliente. |

Fontes: [engenharia do Discord](https://discord.com/blog/how-it-all-goes-live-an-overview-of-discords-streaming-technology),
[guia de compartilhamento do Discord](https://discord.com/blog/how-to-stream-to-discord-from-desktop-or-mobile),
[Teams](https://support.microsoft.com/en-us/teams/meetings/share-sound-from-your-computer-in-microsoft-teams-meetings-or-live-events),
[Zoom](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0063608),
[OBS](https://obsproject.com/kb/application-audio-capture-guide),
[Twitch Desktop](https://blog.twitch.tv/en/2017/08/10/the-new-twitch-desktop-app-is-here-6d6a71c6ec83/).

## Opções técnicas

1. **Capturar aplicativos permitidos.** Manter tela inteira no vídeo e incluir
   somente jogo, player ou outros aplicativos explicitamente escolhidos no áudio.
   Já funciona para um aplicativo; vários exigem mixer com alinhamento temporal,
   normalização/clipping, deduplicação de árvores e limites de recursos.
2. **Capturar tudo menos uma árvore.** WASAPI oferece
   `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`: exclui o processo indicado
   e seus filhos. Serve para uma chamada em aplicativo independente. A API aceita
   um alvo, não uma lista de árvores independentes; exige resolver o PID correto e
   suspender/reconfigurar a captura quando o aplicativo reinicia. Requisito oficial:
   Windows build 20348+. [API Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ne-audioclientactivationparams-process_loopback_mode).
3. **Várias exclusões.** Enumerar sessões/processos e capturar/misturar somente os
   permitidos. Um fork público de `win-capture-audio` usa exclusão nativa quando os
   alvos pertencem a uma árvore e enumeração/inclusão nas demais situações. Isso é
   evidência desse fork, não prova de comportamento de toda versão do OBS.
   Não somar dois streams “tudo menos X”: isso reintroduz as origens excluídas.
   [Implementação consultada](https://github.com/Ayrton09/win-capture-audio/blob/main/src/audio-capture.cpp).
4. **Dispositivos separados/cabo virtual.** Encaminhar chamadas e conteúdo a saídas
   diferentes e capturar somente a saída de conteúdo. Pode atender a casos que
   permitem escolher dispositivos separados dentro do mesmo aplicativo. Exige
   configuração; cabo virtual adiciona driver/instalação, inadequados ao piloto
   portátil como requisito padrão. [Orientação OBS](https://obsproject.com/kb/application-audio-capture-guide).
5. **Abas e constraints WebRTC.** `restrictOwnAudio` trata áudio da aplicação web
   capturadora; não é uma lista de processos externos. `suppressLocalAudioPlayback`
   controla reprodução local da aba capturada. `echoCancellation` trata sinais do
   microfone, não fornece seleção de aplicativos externos. Não substituem o filtro
   nativo para Discord/Teams externos.
   [Screen Capture](https://w3c.github.io/mediacapture-screen-share/),
   [Chrome](https://developer.chrome.com/blog/screen-sharing-improvements-in-chrome-109),
   [Media Capture](https://www.w3.org/TR/mediacapture-streams/).

O Electron expõe loopback geral ou áudio de seus próprios `webContents`; o handler
documentado não recebe lista de PIDs externos. A evolução deve permanecer no helper
nativo, preservando o caminho IPC → AudioWorklet → MediaStream já existente.
[API Electron](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts).

Categorias como `AudioCategory_Communications` e `AudioCategory_GameChat` existem,
mas não constituem um filtro universal do process-loopback. A identificação depende
do aplicativo e do roteamento; não prometer detectar qualquer chamada.
[Categorias Windows](https://learn.microsoft.com/en-us/windows/win32/api/audiosessiontypes/ne-audiosessiontypes-audio_stream_category).

## Recomendação para o projeto

Manter **Aplicativos escolhidos** como padrão seguro e acrescentar seleção múltipla.
Oferecer **Outros sons, exceto os aplicativos da chamada** como modo explícito,
com lista visível de exclusões, detecção de apps conhecidos e seleção manual de
apps desconhecidos. Esse modo tem garantia limitada aos processos efetivamente
excluídos. Chamadas novas ou não identificadas não podem ser consideradas protegidas
automaticamente. Ao perder identificação, suspender o áudio em vez de usar loopback
irrestrito. Excluir também reprodução do Self Live para evitar realimentação.

Descoberta de fontes deve usar sessões de áudio, além de janelas: apps minimizados
ou sem janela podem produzir som. `IAudioSessionControl2::GetProcessId` identifica
o processo da sessão, mas documenta também sessões que abrangem mais de um processo.
[Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/audiopolicy/nf-audiopolicy-iaudiosessioncontrol2-getprocessid).

Uma chamada e um vídeo no mesmo navegador podem compartilhar processo/serviço de
áudio. Excluir a árvore do navegador exclui ambos; manter vídeo com áudio exige uma
origem separada, captura específica da aba por mecanismo apropriado ou roteamento
separado. A API atual não garante som de uma janela/aba isolada dentro do processo.

Validar com chamada Discord real e jogo, Teams e player, duas chamadas independentes,
chamada no navegador, reinício da chamada, alteração de dispositivo e processo sem
janela. Medir áudio antes e depois de Opus no viewer: conteúdo presente e voz da
chamada ausente. Os testes atuais de dois tons validam isolamento por processo;
não cobrem esses cenários completos de chamadas nem o futuro mixer/exclusão.
