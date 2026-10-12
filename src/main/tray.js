const { Tray, Menu, nativeImage } = require('electron');

function createTray(show, action, shutdown) {
  // Ícone bitmap embutido: não depende de caminhos externos no instalador.
  const pixels = Buffer.alloc(16 * 16 * 4);
  for (let i = 0; i < 256; i++) {
    pixels.set([190, 220, 38, 255], i * 4);
  }
  const tray = new Tray(nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }));
  tray.setToolTip('Self Live');
  let menu;
  const update = active => {
    menu = Menu.buildFromTemplate([
    { label: 'Iniciar Transmissão', enabled: !active, click: () => { show(); action('start'); } },
    { label: 'Parar Transmissão', enabled: active, click: () => action('stop') },
    { label: 'Abrir Dashboard', click: show }, { type: 'separator' },
    // O processo principal aguarda a limpeza do renderer antes de app.exit().
    { label: 'Sair', click: () => { void shutdown(); } }
    ]);
    tray.setContextMenu(menu);
  };
  tray.on('double-click', show);
  update(false);
  return { tray, update, get menu() { return menu; } };
}
module.exports = { createTray };
