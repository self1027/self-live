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
