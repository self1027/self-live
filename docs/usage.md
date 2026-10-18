# Como usar o Self Live

[Voltar ao projeto](../README.md) | [Guias](README.md)

## Entrar, compartilhar e assistir

Na primeira abertura, preencha **Seu nome** na tela inicial: criar e entrar em sala
ficam bloqueados enquanto ele estiver vazio. O nome é salvo neste PC ao clicar em
**Salvar**, **Criar sala** ou **Entrar**, e aparece preenchido nas próximas aberturas.
Você pode editá-lo antes de entrar; ele será o nome exibido aos convidados, sem
precisar reiniciar. Perfis antigos com nome personalizado mantêm sua preferência.

A interface separa entrada, sala, transmissão e player. Na entrada, escolha
**Criar uma sala** ou **Tenho um convite**, com um fluxo por vez. Textos em caixa
normal, controles simples e ícones com descrição mantêm as ações principais claras.

Na sala, **Compartilhar tela** abre um único modal com prévias selecionáveis.
Escolha a tela/janela e clique em **Compartilhar**. Resolução e fps usam
suas preferências; áudio, bitrate e exclusões ficam em **Mais opções**.
A captura só começa na confirmação, e cancelar não altera as preferências.
Aplicativos de áudio usam caixas de seleção, sem precisar de Ctrl+clique.
O padrão é **Com áudio**: uma janela envia o som de seu aplicativo, inclusive
Discord quando sua janela for escolhida. Tela inteira envia os aplicativos de
áudio disponíveis, com Discord excluído por padrão. Em **Mais opções**, escolha
**Sem áudio** ou marque/desmarque aplicativos em **Não compartilhar som destes
aplicativos**. Essas exclusões só valem para tela inteira; outras chamadas precisam
ser excluídas por você. A regra Discord inclui Canary, PTB e Development.
O filtro opera por aplicativo, não por janela/aba: outras janelas e chamadas do
mesmo aplicativo também podem ser ouvidas. O microfone não é compartilhado.
**Copiar link** gera e copia o convite; **Copiar senha** copia a senha diretamente,
sem exibi-la ou abrir outro modal. O card confirma cada cópia. Envie-os separadamente.

A seleção de tela/janela mostra uma prévia local estática, renovada por **Atualizar**.
O seletor de qualidade oferece 144p, 240p, 360p, 480p, 720p, 900p e 1080p, além de
**Máxima da fonte**. Telas menores exibem apenas opções compatíveis; a captura
mantém as proporções e fica limitada a 1920 × 1080, sem ampliar janelas menores.
Você também escolhe **15, 30 ou 60 fps**. Resolução e fps ficam salvos junto às
demais preferências. A taxa efetiva pode cair conforme a fonte, o PC e a rede.

Após iniciar com sucesso, o app salva o modo de áudio, os aplicativos, as exclusões
manuais e a qualidade em `share-preferences.json`, no diretório de dados deste usuário
Windows. As preferências sobrevivem ao reinício. A tela/janela sempre exige uma nova
seleção; senhas e identificadores de janela não entram nesse arquivo. Sinalização,
relay, mídia e RTT continuam independentes. Criar sala usa a senha configurada no app.

## Player e saída

Clique em **Assistir** num stream disponível para abrir o player. Você pode
recolher os painéis, usar o modo teatro e entrar em tela cheia. O áudio recebido
começa mudo; use fones ao ativá-lo para evitar realimentação.

O vídeo acompanha o espaço disponível ao redimensionar a janela, preservando
as proporções da fonte. O modo teatro usa toda a largura disponível. Em tela
cheia, use o mesmo botão ou **Esc** para voltar ao tamanho e aos painéis anteriores.

**Parar de assistir** volta à sala. **Parar transmissão** encerra sua captura.
**Sair** da sala mantém o app aberto. Fechar a janela mantém o processo na bandeja;
para encerrar tudo, escolha **Sair** no menu da bandeja.

## Resolução máxima

O limite absoluto é **1920 × 1080**, inclusive em NATIVA, janelas e adaptive.
As constraints incluem máximos desde `getDisplayMedia`; antes de entregar a
captura ao encoder, o app aplica o tamanho proporcional e confere `getSettings()`.
Se o Chromium não respeitar o limite, todas as tracks dessa captura são encerradas.
`SELF_LIVE_MEDIA_WIDTH`/`SELF_LIVE_MEDIA_HEIGHT` não são overrides suportados.

Fontes 4K são reduzidas para até FHD. Ultrawide/portrait preservam as proporções
quando possível: 3440 × 1440 resulta em aproximadamente 1920 × 803, não em uma
imagem esticada. O badge informa o tamanho efetivo. Fontes menores não são ampliadas.
No diagnóstico, confira `captureMode.originalResolution`, `effectiveResolution`,
`downscaled` e `reason: "fhd_cap"`. Quando o tamanho original de uma janela não
estiver disponível, `originalResolution` fica `null`; não usamos a miniatura como
medida da fonte.


