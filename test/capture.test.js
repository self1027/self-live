const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// Executa o módulo sem abrir Electron, simulando o callback nativo de uso único.
function fixture(getSources, displays = []) {
  let handler, permissionHandler;
  const errors = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/capture.js'), 'utf8'), {
    module, URL, console: { error: (...args) => errors.push(args) },
    require: name => {
      assert.equal(name, 'electron');
      return { desktopCapturer: { getSources }, screen: { getAllDisplays: () => displays } };
    }
  });
  const frame = {};
  const contents = {mainFrame:frame,getURL:()=> 'http://127.0.0.1:3000/'};
  const session = {
    setPermissionRequestHandler(callback) { permissionHandler = callback; },
    setDisplayMediaRequestHandler(callback) { handler = callback; }
  };
  const capture = module.exports.setupCaptureHandlers(session, () => ({ webContents: contents }), 'http://127.0.0.1:3000');
  return { capture, errors, request: { securityOrigin: 'http://127.0.0.1:3000/', frame },
    run: (request, callback) => handler(request, callback),
    permission:(permission,details={},sender=contents)=>{let allowed;permissionHandler(sender,permission,value=>{allowed=value;},details);return allowed;} };
}
test('fullscreen is allowed for the trusted main page and denied to foreign frames and automatic requests',()=>{
  const f=fixture(async()=>[]);
  assert.equal(f.permission('fullscreen',{isMainFrame:true,requestingUrl:'http://127.0.0.1:3000/'}),true);
  assert.equal(f.permission('fullscreen',{isMainFrame:false}),false);
  assert.equal(f.permission('fullscreen',{requestingUrl:'https://example.com/'}),false);
  assert.equal(f.permission('fullscreen',{}, {getURL:()=> 'http://127.0.0.1:3000/'}),false);
  assert.equal(f.permission('automatic-fullscreen'),false);
});
test('lista entrega prévias e dimensões físicas do monitor sem enviar objetos nativos', async () => {
  let options;
  const f = fixture(async value => { options = value; return [{ id: 'screen:1', name: 'Tela', display_id: '123',
    thumbnail: { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,QA' } },
    { id: 'window:2', name: 'Janela', thumbnail: { isEmpty: () => true } }]; },
    [{ id: 123, size: { width: 1280, height: 720 }, scaleFactor: 1.5 }]);
  const sources = await f.capture.sources();
  assert.equal(options.thumbnailSize.width, 640);
  assert.equal(sources[0].width, 1920); assert.equal(sources[0].height, 1080);
  assert.ok(sources[0].thumbnail.startsWith('data:image/png'));
  assert.equal(sources[1].thumbnail, null); assert.equal(sources[1].width, null);
});

test('captura resolve fonte, nunca entrega loopback misturado e consome seleção uma vez', async () => {
  const source = { id: 'screen:1', name: 'Tela' };
  const f = fixture(async () => [source]);
  f.capture.select(source.id);
  let calls = 0;
  await f.run(f.request, result => {
    calls++;
    assert.equal(result.video, source);
    assert.equal(result.audio, undefined);
  });
  assert.equal(calls, 1);
  assert.equal(f.capture.activeSource(),undefined);
  f.capture.confirm(source.id);
  assert.equal(f.capture.activeSource(),source.id);
  f.capture.recover();
  await f.run(f.request,result=>assert.equal(result.video,source));
  await f.run(f.request, result => assert.equal(result, null));
});
test('recovery remains bound to the committed source after an uncommitted source switch',async()=>{
  const a={id:'window:123:0'},b={id:'window:456:0'};const f=fixture(async()=>[a,b]);
  assert.throws(()=>f.capture.recover(),/Nenhuma fonte/);
  f.capture.select(a.id);await f.run(f.request,()=>{});f.capture.confirm(a.id);
  f.capture.select(b.id);await f.run(f.request,()=>{});
  assert.equal(f.capture.activeSource(),a.id);
  f.capture.recover();await f.run(f.request,result=>assert.equal(result.video.id,a.id));
  assert.throws(()=>f.capture.confirm('screen:other'),/não confirmada/);
});

test('janela usa seu aplicativo; tela inteira só usa aplicativo escolhido explicitamente', () => {
  const f = fixture(async () => []);
  f.capture.select('window:123:0', 'window:999:0');
  assert.equal(f.capture.audioSource(), 'window:123:0');
  assert.equal(f.capture.audioSource(), undefined);
  f.capture.select('screen:1', 'window:999:0');
  assert.equal(f.capture.audioSource(), 'window:999:0');
  f.capture.select('screen:1', '');
  assert.equal(f.capture.audioSource(), '');
  f.capture.select('screen:1', { mode: 'exclude', applications: ['unknown-call.exe'] });
  assert.equal(f.capture.audioSource().mode, 'exclude');
});

test('callback nativo que lança não é chamado novamente nem rejeita o handler', async () => {
  const f = fixture(async () => [{ id: 'screen:1' }]);
  f.capture.select('screen:1');
  let calls = 0;
  await assert.doesNotReject(f.run(f.request, () => {
    calls++;
    throw new TypeError('Solicitação invalidada');
  }));
  assert.equal(calls, 1);
  assert.equal(f.errors.length, 1);
});

test('falha na enumeração e origem não autorizada são negadas com callback único', async () => {
  let enumerations = 0;
  const f = fixture(async () => { enumerations++; throw new Error('Fonte indisponível'); });
  f.capture.select('screen:1');
  let calls = 0;
  await f.run(f.request, result => { calls++; assert.equal(result, null); });
  assert.equal(calls, 1);
  assert.equal(f.errors.length, 1);
  f.capture.select('screen:1');
  await f.run({ ...f.request, securityOrigin: 'https://example.com' }, result => assert.equal(result, null));
  assert.equal(enumerations, 1);
});
