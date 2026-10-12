# Piloto fechado P2P

[← Self Live](../README.md) · [Documentação](README.md)

Este pacote usa o relay público `wss://relay.murilod.dev:8443` para fallback de
sinalização e STUN/P2P para mídia. O segredo mestre do TURN não acompanha o pacote.
Redes que exigem TURN podem conectar à sala e ainda falhar ao receber mídia.
A emissão autenticada de credenciais TURN pela VPS permanece pendente para a
distribuição que pretende funcionar nessas redes.

## Gerar o executável

No Windows x64, usando o lockfile do projeto:

```powershell
npm ci
npm test
npm run check
npm run test:pilot
npm run test:ui
npm run test:relay
npm run test:fallback
npm run dist:pilot
Get-FileHash .\dist\Self-Live-0.1.0-x64.exe -Algorithm SHA256
```

O alvo `portable` gera um EXE que não exige instalação de Node.js/npm nos peers.
`npm run dist` continua gerando MSI. O pacote não está configurado com um
certificado de assinatura de código; o Windows pode mostrar um aviso de publicador.

## Testar em dois PCs

1. Copie o mesmo EXE para os dois PCs e execute com o usuário comum do Windows.
2. No PC A, abra **Configurar este PC**. Escolha seu nome e, opcionalmente, sala
   e senha. Salve e use **Reiniciar aplicativo** para aplicar as alterações.
3. No PC A, clique **Criar sala**.
4. Em **Convide alguém**, clique **Copiar link** e depois **Copiar senha**.
   Cada botão copia diretamente, sem mostrar a senha ou abrir modal. Envie
   convite e senha por um canal privado ao PC B.
5. No PC B, cole o convite, informe a senha de A e clique **Entrar**. A sala local
   de B não precisa ter o mesmo nome ou senha: o convite escolhe a sala de A.
6. Em A, clique **Quero transmitir**, selecione a fonte e confirme **Compartilhar**.
   Em B, clique **Assistir**. Confira vídeo, áudio e sinalização/mídia separadamente.
7. Pare os streams e encerre ambos pela opção **Sair** da bandeja. Fechar a janela
   apenas oculta o dashboard e mantém o aplicativo ativo.

Use inicialmente a mesma LAN, depois redes distintas. Permita o aplicativo no
firewall do Windows quando solicitado; não é necessário desativar o firewall.
Teste por 30–60 minutos, incluindo parar/retomar, fechar janela e reabrir pela bandeja.

## Configuração local

No primeiro boot, o aplicativo cria `pilot-config.json` no diretório `userData`
do Electron (normalmente `%APPDATA%\self-live`). A UI permite editar nome, sala,
senha, URL do relay e UPnP. Portas HTTP/WSS/UDP são selecionadas automaticamente.
O padrão do piloto deixa UPnP desligado; ele pode ser ativado pela configuração.

Cada perfil gera uma sala imprevisível e uma senha aleatória própria. A senha
é cifrada pelo `safeStorage` do Electron no perfil Windows. Não copie esse arquivo
entre usuários/PCs: copie o EXE e compartilhe apenas convite e senha da sala.
Essa proteção local não impede que o próprio usuário ou malware em sua sessão
acesse a senha. Nenhuma senha é gravada no repositório ou dentro do EXE.

Variáveis de ambiente explícitas ainda prevalecem sobre a configuração local.
Se usou PowerShell com variáveis antigas, feche o terminal e abra o EXE pelo
Explorador; variáveis permanentes do Windows precisam ser removidas/atualizadas.
O arquivo local não admite segredo TURN. O fluxo legado por ambiente continua
disponível para desenvolvimento, mas não é necessário para este piloto P2P.

As alterações exigem reinício para manter sala, relay e WSS consistentes.
Se o arquivo estiver corrompido ou sua senha não puder ser decifrada, o app informa
falha no boot em vez de substituir silenciosamente as credenciais. Para resetar,
encerre o aplicativo e renomeie o arquivo; o próximo boot cria uma sala nova.

## Verificações automatizadas

Para investigar engasgos em jogos, ative logs na página inicial antes da captura.
Eles ficam em **Documentos/SelfLive-Logs**, sem gravação automática ao lado do EXE.
Veja [o procedimento de auditoria](stream-audit.md). O adaptive reduz trabalho de
captura, mas não reserva recursos gráficos nem garante fluidez com GPU saturada.

`test:pilot` executa o main/preload reais em um perfil temporário: salva pela UI,
verifica que a senha não está em texto puro, abre um segundo processo com o mesmo
perfil e cria a sala sem digitar a senha. Usa o armazenamento seguro real do Windows.
`test:ui`, `test:relay` e `test:fallback` cobrem mídia sintética em processos Electron.
Captura real e comportamento em duas redes distintas devem ser validados nos PCs.
