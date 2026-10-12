# Áudio isolado e exclusão de chamadas

Em **Compartilhar tela → Mais opções → Áudio da transmissão**, há duas escolhas:
**Com áudio** (padrão) e **Sem áudio**. O som acompanha a fonte selecionada:

| Modo | Áudio enviado |
| --- | --- |
| Com áudio · janela | Árvore de processos do aplicativo da janela, inclusive Discord, navegadores e outros apps de chamadas quando escolhidos explicitamente. |
| Com áudio · tela inteira | Aplicativos disponíveis, exceto Discord por padrão e os que você marcar nas exclusões. |
| Sem áudio | Apenas vídeo. |

Na tela inteira, **Não compartilhar som destes aplicativos** aparece somente com
áudio ligado. Marque os aplicativos que devem ficar fora ou desmarque Discord
para compartilhar seu som. Selecionar uma janela ignora essas exclusões:
se você escolher a janela do Discord, seu som será compartilhado.
A chamada continua sendo reproduzida normalmente nos seus fones; só a captura
para a transmissão é filtrada.

## Exclusões e descoberta

Discord (incluindo Canary/PTB/Development) é a única exclusão inicial configurável.
Teams, Zoom, navegadores e outras chamadas precisam ser marcados por você na
tela inteira. Self Live e sua árvore de processos continuam sempre fora para
evitar realimentação. As exclusões não silenciam aplicativos nos seus fones.

No modo de exclusão, marque outros aplicativos ou informe nomes de executável,
por exemplo MinhaCall.exe; OutroApp.exe. Não use caminhos completos. Regras manuais
valem mesmo quando o aplicativo abrir depois ou reiniciar com outro PID. Áudio,
exclusões e qualidade são salvos após iniciar a transmissão com sucesso; cancelar
não altera as preferências. Preferências antigas de exclusão são preservadas;
listas antigas de inclusão não viram exclusões. O padrão migrado inclui Discord.

A lista usa sessões de áudio de todos os dispositivos de saída ativos, incluindo
apps minimizados/sem janela. Abra o app, reproduza um som e clique **Atualizar**
se ele não aparecer. A regra vale para todas as instâncias do mesmo executável.
O painel mostra fontes em uso e exclusões. Pare a transmissão para mudar as regras.

## Implementação

Vídeo continua com getDisplayMedia e audio: false. O helper WASAPI captura apenas
árvores permitidas. O main enumera sessões/processos, evita duplicação pai/filho e
recusa árvores com descendentes excluídos identificados. Não soma capturas “tudo
menos X”, pois isso reintroduziria fontes proibidas.

Pacotes PCM16 estéreo/48 kHz incluem timestamps QPC do Windows. O mixer alinha
fontes, limita saturação e descarta atraso acumulado, antes de IPC/preload,
AudioWorklet e Opus/WebRTC. Limite: 16 fontes simultâneas. Sessões são revistas
a cada segundo. Falha de enumeração/captura suspende o áudio e avisa no painel,
mantendo vídeo; não existe fallback para loopback irrestrito.

## Limites

- Exige Windows build 20348+, incluindo Windows 11. Windows 10 comum build 19045
  não oferece a API documentada. Sistemas incompatíveis transmitem só vídeo.
- Filtra processos, não voz, janelas ou abas. Chamadas dentro do próprio jogo ou
  conteúdo misturado no mesmo processo não podem ser separados por esse filtro.
- Um navegador escolhido pode compartilhar chamadas e conteúdo juntos. Excluí-lo
  na tela inteira exclui seu áudio inteiro, não apenas uma aba.
- Exclusão protege os processos identificados pelas regras. Apps desconhecidos
  exigem exclusão manual. Mudanças de árvore são revisadas periodicamente, não
  atomicamente com cada criação de processo. Para conteúdo sensível, compartilhe
  um aplicativo separado ou use Sem áudio.
- Uma janela envia o áudio do aplicativo e seus processos filhos. Várias janelas
  do mesmo aplicativo podem compartilhar o mesmo áudio; não há isolamento por HWND.
- Sons sem PID/sessão identificável ficam fora. O modo de exclusão não promete
  capturar todo sinal do dispositivo físico nem todos os sons do sistema.
- Aplicativos ausentes podem permanecer em silêncio até sua sessão aparecer.
- Os testes não reproduzem chamadas reais de todos os serviços; valide nos PCs.

## Compilar e testar

No desenvolvimento, instale Visual Studio Build Tools 2022 com Desktop development
with C++ e Windows SDK recente. Execute npm run build:audio antes de npm start.

dist e dist:pilot compilam automaticamente o helper e incluem
resources/audio/app-audio.exe com runtime estático. PCs de destino não precisam
de SDK, Node ou Visual Studio. Substitua o EXE antigo pela nova build.

Execute npm test, npm run check, npm run test:audio e npm run test:ui.

O teste nativo usa processos independentes emitindo 440/660/880/1100 Hz, com
executáveis distintos. Valida janela de jogo, janela explícita do Discord, remoção
da exclusão de Discord, exclusões de tela inteira e app aberto depois, além de
descoberta/captura sem janela e compatibilidade com os modos internos anteriores.
Mede no viewer após Opus: conteúdo presente e sons excluídos abaixo de 1/15 da
amplitude do conteúdo. Não substitui a captura nativa por áudio sintético.

Nos PCs, abra jogo/player e uma chamada Discord ou Teams independentes. Em A,
selecione tela inteira e **Mais opções → Com áudio**, com o app da chamada marcado
nas exclusões; em B, confirme música/efeitos
e ausência da própria voz na transmissão. Confira o painel de exclusões, repita
com app desconhecido informado manualmente e reinicie a chamada. Teste também
troca de dispositivo de saída. Se chamada e conteúdo estiverem no mesmo app,
use roteamento separado ou transmita sem áudio.

Referências: [Microsoft — process loopback](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ne-audioclientactivationparams-process_loopback_mode),
[OBS — áudio por aplicativo](https://obsproject.com/kb/application-audio-capture-guide)
e [levantamento técnico](audio-call-isolation-research.md).

