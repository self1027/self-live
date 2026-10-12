# Auditoria de transmissão sob carga

Ao começar a compartilhar, o app cria automaticamente um arquivo
`self-live-audit-DATA-PID.jsonl` **na pasta do EXE portátil**. Nenhuma configuração
é necessária. Pare a transmissão antes de enviar o arquivo; assim ele terá o
registro de encerramento. O diagnóstico avançado informa o nome do arquivo.

Se a pasta não permitir escrita, o arquivo fica em `audit` dentro dos dados do
app (`%APPDATA%\self-live`, conforme o perfil da instalação). O diagnóstico avisa
quando isso acontecer. Em desenvolvimento, os logs ficam na raiz do projeto.
Falha no diagnóstico não interrompe a transmissão. Nada é enviado automaticamente.

## O que coletamos

- Versões do app, Electron/Chromium e Windows; arquitetura, número de threads e RAM.
- Identificadores PCI não exclusivos dos adaptadores e versão do driver, quando disponível.
- Configuração de captura, teto de bitrate e política de adaptação usados nesta build.
- A cada 2 segundos: fps da fonte quando exposto pelo WebRTC, fps codificado/enviado,
  resolução do envio, bitrate efetivo, tempo médio de encoding, motivo e duração
  das limitações, RTT/perda/jitter reportados e número de viewers.
- Uso de CPU e memória dos processos do Self Live; estado da prévia e do teste local.
- A cada 10 segundos: carga dos motores 3D, cópia, compute e vídeo disponíveis
  nos contadores Windows. Os valores representam o motor mais ocupado entre os
  adaptadores, somando seus processos; não identificam qual jogo ou GPU o produziu.
  A duração da consulta também é registrada. Se a consulta falhar, ela é desativada
  até a próxima transmissão, sem afetar vídeo ou áudio.

Os viewers recebem números locais à sessão (1, 2…), sem nome ou `node_id`.
Não coletamos senha, hash, convite, endereço IP, candidatos ICE, SDP, nome da
sala/janela/processo do jogo, imagens, áudio ou conteúdo transmitido.

Cada arquivo tem limite aproximado de **5 MiB**. Ao atingir o limite, registra
`size_limit` e para de acrescentar amostras, mantendo o encerramento. O app conserva
os **10 arquivos mais recentes** em cada pasta e remove somente seus próprios
arquivos de auditoria com o padrão de nome gerado. Outros arquivos permanecem.

## Teste com CS

1. Use a nova build em uma pasta com permissão de escrita. Inicie CS e conecte
   **um viewer**, mantendo o teste de mídia local desligado.
2. Compartilhe uma cena com movimento por 2–3 minutos nas configurações que
   apresentam o problema. Anote o horário aproximado da piora. Pare a transmissão
   e guarde o primeiro arquivo.
3. Repita a mesma cena, resolução, fps e bitrate, alterando somente o limite de
   fps do jogo para deixar margem na GPU. Pare e guarde o segundo arquivo.
4. Envie os dois arquivos e informe resolução do monitor, configurações usadas
   e se o defeito era travamento, atraso ou imagem borrada.

Não precisa executar como administrador. Evite modificar várias opções entre
testes, pois isso dificulta identificar a causa.

## Como interpretar

`capture.frameRate` é a configuração reportada pela track, não uma medição da
cadência real. Use `media-source.framesPerSecond`, `encodedFps` e `sentFps` quando
disponíveis. A primeira amostra não contém taxas calculadas: elas exigem duas
leituras. `encodeMs` usa diferenças de tempo total e frames entre amostras.

`limitation: cpu` indica limitação de processamento reportada pelo WebRTC; não é
uma medida direta da CPU nem prova que a GPU é a causa. Os contadores de GPU,
fps da fonte, tempo de encoding e teste comparativo ajudam a separar as hipóteses.
`hardwareEfficient` é opcional e a categoria `hardware-or-external` não garante
aceleração por hardware. Campos ausentes significam informação indisponível.

O arquivo do streamer registra o feedback RTP disponível do viewer, mas não
mede diretamente sua GPU, fps de apresentação ou congelamentos do player remoto.
Esses dados exigiriam auditoria também no viewer. A coleta de contadores tem custo
pequeno, porém não nulo; sua duração fica registrada para avaliar interferência.
