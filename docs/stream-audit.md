# Auditoria de transmissão sob carga

[← Self Live](../README.md) · [Documentação](README.md)

Na página inicial, abra **CONFIGURAÇÕES DE DIAGNÓSTICO** e ative **ATIVAR LOGS DE
DIAGNÓSTICO** antes de transmitir. O padrão é OFF e a preferência fica em
`config/local.json`, dentro dos dados do usuário do app. Não exige reinício.
O toggle só existe na página inicial e fica bloqueado durante captura ativa.

Os arquivos são gravados em **Documentos/SelfLive-Logs**, com nome
`diagnostic-DATA-PID-PARTE.jsonl`. Use **ABRIR PASTA DE LOGS**. Cada parte tem até
10 MiB, conservando as cinco últimas partes geradas. Pare antes de enviar para
incluir o registro de encerramento. Não há mais criação automática ao lado do EXE.
Se a pasta não puder ser gravada, o app avisa e mantém a transmissão.

## Experimento comparável

### Alt+Tab, minimização e retomada

A sessão WebRTC e o áudio por aplicativo são mantidos quando a fonte fica em
segundo plano ou minimizada. Um helper consulta apenas a janela já escolhida,
sem gravar seu título nem o aplicativo que ganhou foco. O estado da janela
independe da visibilidade do dashboard do Self Live.

Enquanto a janela está em segundo plano, oculta ou minimizada, o adaptive
preserva a qualidade e zera os contadores de sobrecarga. Ao voltar, há seis
segundos de estabilização antes de novas decisões de qualidade. O app continua
acompanhando a fonte mesmo com logs e adaptive desligados, sem gravar arquivos.

Se os frames retornarem naturalmente, a captura é preservada. Se a track terminar,
ficar sem dados ou não recuperar frames após a volta, o app tenta recapturar
somente a mesma fonte e substituir o vídeo nos senders existentes. O MediaStream,
o áudio e as conexões dos espectadores são preservados. Há até três tentativas,
com espera crescente; voltar o foco ou receber frames libera um novo ciclo.
Parar a transmissão cancela o tratamento. A janela realmente fechada tem uma
tolerância de 12 segundos antes de encerrar; não há troca automática para a tela
inteira ou para outra janela.

Se o aplicativo deixar de renderizar ao minimizar, a conexão permanece, mas não
há novos frames para transmitir: a imagem fica no último frame até a fonte voltar.
Não se força foco nem se restaura a janela do usuário automaticamente.

Nos JSONL, `sample.captureLifecycle` e eventos `capture-state` distinguem `live`,
`background`, `waiting` e `recovering`. Incluem motivo, estado `muted`/`ended` da
track, foco/minimização/visibilidade conhecidos e supressão do adaptive. O export
inclui até 100 eventos em `captureStateEvents`. Estado indisponível é registrado
como desconhecido, sem assumir que a janela foi fechada.

`npm run test:capture-state` compila o helper, valida o ciclo de recuperação e
consulta uma janela Electron isolada. `npm run test:ui` simula minimização com
encerramento da track e confirma que o viewer recebe novos frames na mesma
conexão e com a mesma track de áudio após a recuperação.

### Prioridade de GPU (experimental)

Em **CONFIGURAÇÕES DE DIAGNÓSTICO**, marque **usar prioridade de gpu** antes
da captura. A preferência é salva e vem desligada por padrão. Não exige reinício.
Pare a captura para alterar, assim como no checkbox de logs. A opção funciona
independentemente dos logs; ative ambos para registrar a comparação.

O helper nativo solicita a classe de agendamento GPU **HIGH**, sem mudar a
prioridade de CPU nem solicitar REALTIME. Os alvos são os processos Browser,
GPU, Tab e Utility enumerados pelo próprio Electron; nenhum PID é recebido do
renderer. O app acompanha novos processos enquanto a opção está ativa.
A interface distingue confirmação, aplicação parcial e recusa do Windows.
As chamadas e classes são descritas nas referências oficiais de
[consulta de prioridade](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/d3dkmthk/nf-d3dkmthk-d3dkmtgetprocessschedulingpriorityclass)
e [classes de agendamento](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/d3dkmthk/ne-d3dkmthk-_d3dkmt_schedulingpriorityclass).
Uma recusa de consulta em um renderer sem contexto GPU não significa que o
processo GPU também recusou: veja `gpuProcessConfirmed` e os resultados por alvo.

O helper mantém o handle e a prioridade original de cada processo alterado.
Ao desmarcar ou sair normalmente, restaura a classe anterior e verifica a
leitura. Se o processo principal terminar inesperadamente, o fechamento do
pipe também solicita a restauração. Se a prioridade tiver sido alterada por
outro agente enquanto isso, preserva essa alteração. Falhas de restauração são
exibidas; nesse caso, feche e reabra o aplicativo antes de comparar.

Nos JSONL, `start.gpuPriority`, `sample.gpuPriority` e eventos `gpu-priority`
registram o estado solicitado e observado, PID/tipo do processo, classe original,
solicitada e efetiva, NTSTATUS e erro Win32 quando disponível. O export preserva
o estado inicial da sessão e até 100 alterações, mesmo se você desmarcar a opção
depois de parar a transmissão. HIGH aceita pelo Windows não comprova melhoria
na entrega de frames nem identifica a política usada pelo Discord.

Para comparar, desligue adaptive, mantenha fonte/resolução/FPS/bitrate/preview,
cena do jogo e viewer iguais. Faça uma sessão com a opção OFF, outra ON e uma
terceira OFF, sempre com logs e jogo sob a mesma carga. Exporte cada sessão
antes de iniciar a seguinte. Compare FPS observado/enviado, stalls, encode e
congelamentos no viewer; observe também o desempenho do jogo. O app não mede
automaticamente os tempos de frame do jogo nem a latência completa do viewer.

No desenvolvimento, compile com `npm run build:gpu-priority`. O empacotamento
MSI/portátil compila e inclui o helper automaticamente. `npm run test:gpu-priority`
valida a política e executa as chamadas reais em uma instância Electron isolada
e oculta, restaurando as prioridades ao final. O teste não abre jogos.

### Demais controles

1. Ative logs na página inicial. Entre na sala e compartilhe a mesma fonte com
   a mesma resolução, FPS e bitrate, sempre limitados a 1920 × 1080.
2. Nos controles avançados da transmissão, desligue **ADAPTIVE** para o teste
   manual não mudar a qualidade. Conecte um viewer, jogue com FPS ilimitado por
   pelo menos dois minutos, pare e exporte o diagnóstico pelo diagnóstico geral.
3. Repita alterando somente o cap de FPS do jogo para 144. Esse cap é configurado
   no jogo; o FPS de captura é outra configuração.
4. Compare separadamente preview visível/oculto, 60/45/30/20/15 fps de captura e
   FHD/720p/540p/480p. Desligue adaptive para liberar esses controles.
5. Faça uma sessão com adaptive ON, jogo ilimitado e viewer conectado. Observe
   notificações de ajustes; depois alivie a GPU e aguarde recuperação.
6. Envie os JSONL e os JSONs exportados, junto de GPU, monitor, configurações do
   jogo e descrição do problema: engasgo, atraso ou borramento.

Não precisa executar como administrador. O experimento CPU não é suportado a
quente pelo pipeline atual: ao tentar ativá-lo, o app informa GPU mantida. Não
desativa globalmente a aceleração nem troca o encoder.

## Interpretação

`capture.frameRate` e `captureMode.frameRate` descrevem a configuração, não a
cadência observada. Use `observedFps`/`media-source.framesPerSecond`, `encodedFps`
e `sentFps`. Taxas calculadas e `encodeMs` exigem duas leituras consecutivas.

`captureGap` = FPS alvo / FPS observado. `captureStall` indica FPS observado
abaixo de 75% do alvo; conteúdo estático também pode gerar FPS baixo. Contadores
não disponibilizados pelo Chromium ficam `null`. O arquivo não inventa números
de frames descartados ou congelados.

`busiestEnginePercent` e `engineSaturation` mostram a engine mais ocupada do
sistema, não exclusivamente o jogo nem obrigatoriamente a GPU da captura.
`gpuScope`, `gpuTime` e `gpuAgeMs` tornam essa limitação explícita. A GPU é lida
a cada 10 segundos; as amostras de captura usam esse último valor por até 15
segundos. Falhas de leitura geram indisponível e são tentadas novamente.

GPU 3D alta com captura lenta é compatível com contenção gráfica. Não identifica
por si só uma espera do DWM. `limitation: cpu` é uma classificação WebRTC e não
uma medição de CPU. `hardwareEfficient`/categoria de encoder são opcionais e
não comprovam um SDK específico. Não se registra conteúdo, senha, IP ou SDP/ICE.

O adaptive avalia quatro amostras de dois segundos, com no mínimo dez segundos
entre ajustes, e exige GPU alta junto com captura lenta. A recuperação exige
seis observações de GPU ≤60% e captura sem stall. Sem GPU válida ou FPS observado,
preserva a qualidade. Com logs OFF, adaptive ON ainda mede o mínimo necessário;
OFF em ambos encerra essa coleta adicional.

O export inclui as últimas 1000 amostras gravadas da sessão, configuração e
resumo agregado da sessão toda. `samplesTruncated` indica truncamento em sessões
mais longas. Arquivos exportados não são removidos pela rotação JSONL. O streamer
não mede a latência completa até a tela do viewer.

## Resultado observado no piloto

Comparação de duas sessões em 12/10/2026, considerando somente amostras com
viewer conectado. Ambas usaram 1920 × 1080 e mídia P2P direta IPv4.

| Métrica | Sessão com engasgos | Sessão fluida |
| --- | ---: | ---: |
| FPS médio da fonte | 14,0 | 53,5 |
| FPS médio enviado (deltas) | 14,1 | 51,5 |
| GPU 3D média nas amostras | 91,7% | 35,1% |
| VideoEncode médio nas amostras | 2,8% | 9,0% |
| Tempo médio de encode por frame | 6,0 ms | 5,6 ms |
| RTT médio | 26,7 ms | 26,5 ms |
| Perda de pacotes reportada | 0 | 0 |

As médias GPU reutilizam leituras de dez segundos. Elas não representam uma
medição independente a cada amostra nem isolam o processo do jogo.

Na sessão ruim, a fonte entregou poucos frames e o encoder enviou aproximadamente
a mesma quantidade. Isso sustenta contenção no caminho gráfico antes do encode,
mas não identifica exclusivamente DWM ou uma operação específica bloqueada.
Os logs não registram limite de FPS ou configurações gráficas do jogo.

O adaptive ocultou o preview e reduziu 60 → 45 → 30 → 20 fps. Os passos até 30 fps
não produziram melhora sustentada; a sessão terminou logo depois do ajuste para
20 fps. A resolução permaneceu FHD: reduções para 720p/540p e recuperação automática
ainda não foram avaliadas nesse experimento. A sessão fluida foi uma captura
separada, não uma recuperação registrada na mesma sessão.

Leituras de GPU de 86%/88% interromperam a sequência exigida de ≥90%, apesar da
fonte continuar lenta. Revisar essa política é uma possibilidade futura, não uma
correção implementada ou validada. O adaptive atual não resolve todos os casos.

Para investigar mais, mantenha o cenário do jogo e compare, com adaptive OFF:
1080p60/preview oculto, 720p30, 540p20 e 1080p60 com FPS do jogo limitado.
Mude uma condição por vez, documente as configurações e conecte sempre um viewer.

## O que está fora do pipeline atual

Captura por CPU a quente, integração OBS, hook na swapchain e integração própria
DXGI/NVENC/AMF não estão implementados. Prioridade de CPU não reserva GPU. Nenhuma
dessas alternativas deve ser interpretada como solução garantida a partir dos logs.
