# Documentação

[← Self Live](../README.md)

## Usar e testar

| Guia | Conteúdo |
| --- | --- |
| [Como usar](usage.md) | Nome, sala, convite, compartilhamento, áudio, player e resolução. |
| [Piloto portátil](pilot.md) | Build Windows x64, configuração local e teste em dois PCs. |
| [Áudio por aplicativo](application-audio.md) | Exclusão do Discord, janelas, requisitos Windows e helper nativo. |
| [Diagnóstico de transmissão](stream-audit.md) | Logs, adaptive, experimentos e contenção de GPU. |

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
- Sem integração OBS, captura própria DXGI/NVENC/AMF ou atualização automática.

Os exemplos de infraestrutura descrevem configuração e operação; um teste local
aprovado não garante conectividade entre quaisquer redes.
