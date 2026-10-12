# Auditoria de transmissão sob carga

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

1. Ative logs na página inicial. Entre na sala e compartilhe a mesma fonte com
   a mesma resolução, FPS e bitrate, sempre limitados a 1920 × 1080.
2. Nos controles avançados da transmissão, desligue **ADAPTIVE** para o teste
   manual não mudar a qualidade. Conecte um viewer, jogue com FPS ilimitado por
   30–60 segundos, pare e exporte o diagnóstico pelo diagnóstico geral.
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
