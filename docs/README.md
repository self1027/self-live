# Documentação

[← Self Live](../README.md)

## Usar e testar

| Guia | Conteúdo |
| --- | --- |
| [Como usar](usage.md) | Nome, sala, convite, compartilhamento, áudio, player e resolução. |
| [Piloto portátil](pilot.md) | Build Windows x64, configuração local e teste em dois PCs. |
| [Áudio por aplicativo](application-audio.md) | Exclusão do Discord, janelas, requisitos Windows e helper nativo. |
| [Diagnóstico de transmissão](stream-audit.md) | Logs, adaptive, experimentos e contenção de GPU. |
| [MVP de captura C++](native-mvp.md) | Experimento WGC/D3D11/H.264/WebRTC, somente vídeo e um espectador na LAN. |

## Desenvolver e operar

| Guia | Conteúdo |
| --- | --- |
| [Desenvolvimento e testes](development.md) | Executar pelo código, loopback, dois/três peers e suites automatizadas. |
| [Rede e arquitetura](networking.md) | WSS, convites, IPv6, mapeamento de portas, TURN e shutdown. |
| [Provisionar relay](relay-setup.md) | HTTPS/WSS, certificados, configuração, monitoramento e manutenção da VPS. |
| [Provisionar TURN](turn-setup.md) | Coturn, segredo servidor, portas e credenciais temporárias. |

[Pesquisa sobre isolamento de chamadas](audio-call-isolation-research.md) registra
alternativas estudadas; o comportamento implementado está no guia de áudio.

## Estado da entrega

- Piloto fechado Windows x64, com captura Chromium e mídia P2P.
- Relay público de sinalização configurado por padrão; pode ser desativado.
- Captura limitada a 1920 × 1080, com áudio separado por aplicativo.
- Diagnóstico e adaptive disponíveis; GPU saturada ainda pode causar engasgos.
- Emissão autenticada de credenciais TURN para distribuição permanece pendente.
- A aplicação principal mantém captura Chromium. O MVP separado oferece captura
  WGC em C++ e encoder de hardware para comparação, sem migração das salas.
- Sem integração OBS ou atualização automática.

Os exemplos de infraestrutura descrevem configuração e operação; um teste local
aprovado não garante conectividade entre quaisquer redes.
