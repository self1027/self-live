// UI fixtures only: this never starts the native helper or opens network connections.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

if (!process.versions.electron) {
  const {spawnSync} = require('node:child_process');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const result=spawnSync(require('electron'),[__filename],{env,windowsHide:true,stdio:'inherit',timeout:60000});
  if(result.error)throw result.error;
  process.exitCode=result.status ?? 1;
} else if(process.type==='renderer') {
  const fixture=window.uiFixture={calls:[],emit:null,sent:[],failJoin:false};
  const network={turnUrl:'',turnUsername:'',turnAuth:'secret',forceRelay:false,hasCredential:false};
  window.nativeMvp={
    sources:async()=>({windows:[{id:'100',name:'Jogo de teste · janela compartilhada'}],adapters:[{index:0,name:'GPU de teste'}]}),
    network:async()=>network,saveNetwork:async value=>({...network,...value}),
    start:async options=>{fixture.calls.push(['start',options]);return {local:'http://127.0.0.1/viewer#fixture',lan:[],internet:'selflive-native:fixture',adapter:'GPU de teste',encoder:'H.264 por hardware',width:1920,height:1080,fps:60,log:null};},
    stop:async()=>{},openViewer:async()=>{},copyLink:async()=>{},openLogs:async()=>{},
    join:async(...args)=>{fixture.calls.push(['join',...args]);if(fixture.holdJoin)await new Promise(resolve=>{fixture.releaseJoin=resolve;});if(fixture.failJoin)throw new Error('Convite expirado. Peça um novo convite ao transmissor.');},
    onEvent:callback=>{fixture.emit=callback;}
  };
  class MockPeer {
    constructor(){this.connectionState='new';fixture.peer=this;}
    setConfiguration(value){fixture.configuration=value;}
    getStats(){return Promise.resolve(new Map());}
    close(){this.connectionState='closed';this.onconnectionstatechange?.();}
  }
  class MockSocket {
    static OPEN=1;
    constructor(){this.readyState=1;fixture.socket=this;setTimeout(()=>this.onopen?.(),0);}
    send(value){fixture.sent.push(JSON.parse(value));}
    close(){this.readyState=3;}
  }
  window.RTCPeerConnection=MockPeer;window.WebSocket=MockSocket;
} else {
  const {app,BrowserWindow}=require('electron');
  const screenshots=path.join(__dirname,'../dist/native-automatic-ui-fixtures');
  const ui=path.join(__dirname,'../src/native-mvp/ui');
  app.commandLine.appendSwitch('force-prefers-reduced-motion','reduce');
  app.whenReady().then(async()=>{
    fs.mkdirSync(screenshots,{recursive:true});
    const window=new BrowserWindow({show:false,width:1160,height:980,useContentSize:true,webPreferences:{preload:__filename,contextIsolation:false,sandbox:false}});
    const evaluate=code=>window.webContents.executeJavaScript(code,true);
    const screenshot=async name=>{
      await new Promise(resolve=>setTimeout(resolve,500));
      fs.writeFileSync(path.join(screenshots,name+'.png'),(await window.webContents.capturePage()).toPNG());
    };
    const click=id=>evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    const text=id=>evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
    const noOverflow=()=>evaluate('document.documentElement.scrollWidth<=innerWidth');
    const emit=value=>evaluate(`uiFixture.emit(${JSON.stringify(value)})`);
    await window.loadFile(path.join(ui,'host.html'));
    assert.equal(await evaluate("document.getElementById('start').disabled"),false);
    assert.equal(await evaluate("document.getElementById('network-options').open"),false);
    await screenshot('host-idle-1160');
    await click('join');assert.equal(await evaluate("document.activeElement.id"),'invitation');
    assert.equal(await evaluate("document.getElementById('invitation').getAttribute('aria-invalid')"),'true');
    await evaluate("uiFixture.holdJoin=true;document.getElementById('logging').checked=false;document.getElementById('invitation').value='selflive-native:fixture'");
    await click('join');
    assert.equal(await evaluate("document.getElementById('join').disabled"),true);
    assert.equal(await text('join'),'Abrindo…');
    await evaluate('uiFixture.releaseJoin();uiFixture.holdJoin=false');
    assert.deepEqual(await evaluate("uiFixture.calls.find(row=>row[0]==='join')"),['join','selflive-native:fixture',false]);
    await emit({type:'connection-stage',role:'receiver',stage:'trying',method:'ipv6'});
    assert.match(await text('join-signal'),/IPv6/);
    await emit({type:'connection-stage',role:'receiver',stage:'connected',method:'relay'});
    assert.match(await text('join-signal'),/relay/);assert.doesNotMatch(await text('join-media'),/TURN/);
    await emit({type:'connection-stage',role:'receiver',stage:'failed',method:'relay',code:'media_disconnected'});
    assert.doesNotMatch(await text('join-signal'),/falha/);assert.match(await text('join-media'),/interrompida/);
    await screenshot('host-connecting-1160');
    await evaluate("uiFixture.failJoin=true;document.getElementById('invitation').value='expired'");await click('join');
    assert.match(await text('join-status'),/expirado/);assert.doesNotMatch(await text('join-status'),/TURN/);
    await screenshot('host-error-1160');
    await click('start');assert.equal(await evaluate("document.getElementById('source').disabled"),true);
    await emit({type:'receiver-sample',decodedFps:59.5,transport:{mode:'direct'}});
    assert.match(await text('network-path'),/P2P/);
    await screenshot('host-transmitting-1160');
    for(const width of [375,768,1024,1440]){window.setContentSize(width,1000);assert.equal(await noOverflow(),true,`host overflow at ${width}`);}
    window.setContentSize(375,1000);await screenshot('host-transmitting-375');
    await click('stop');
    await evaluate("document.getElementById('network-options').open=true;document.getElementById('turn-auth').value='credentials';document.getElementById('turn-auth').dispatchEvent(new Event('change'))");
    assert.equal(await evaluate("document.getElementById('turn-secret-fields').hidden"),true);assert.equal(await noOverflow(),true);
    assert.equal(await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"),true);
    await window.loadFile(path.join(ui,'viewer.html'),{query:{remote:'1'}});
    window.setContentSize(1160,800);
    await click('fullscreen');
    for(let attempt=0;attempt<40&&!await evaluate('!!document.fullscreenElement');attempt++)await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(await evaluate("document.fullscreenElement?.id"),'stage');
    assert.equal(await evaluate("document.getElementById('video').getBoundingClientRect().width===document.getElementById('stage').getBoundingClientRect().width"),true);
    await evaluate('document.exitFullscreen()');
    await evaluate("uiFixture.socket.onmessage({data:JSON.stringify({type:'connection-stage',stage:'connected',method:'relay'})})");
    assert.match(await text('signal-path'),/relay/);assert.doesNotMatch(await text('media-path'),/TURN/);
    await screenshot('viewer-connecting-1160');
    await evaluate("uiFixture.socket.onmessage({data:JSON.stringify({type:'connecting',iceServers:[]})})");
    assert.ok(await evaluate("uiFixture.sent.some(row=>row.type==='receiver-state'&&row.state==='connecting')"));
    await evaluate("uiFixture.peer.connectionState='connected';uiFixture.peer.onconnectionstatechange()");
    assert.ok(await evaluate("uiFixture.sent.some(row=>row.type==='receiver-state'&&row.state==='connected')"));
    await evaluate("uiFixture.socket.onmessage({data:JSON.stringify({type:'connection-stage',stage:'failed',method:'relay',code:'media_disconnected'})})");
    assert.doesNotMatch(await text('signal-path'),/falha/);assert.match(await text('media-path'),/interrompida/);
    await evaluate("uiFixture.socket.onmessage({data:JSON.stringify({type:'error',message:'Transmissor indisponível. Peça um novo convite.'})})");
    assert.doesNotMatch(await text('status'),/TURN/);
    await evaluate("uiFixture.peer.connectionState='failed';uiFixture.peer.onconnectionstatechange()");
    assert.match(await text('status'),/Transmissor indisponível/);assert.doesNotMatch(await text('status'),/TURN/);
    await evaluate("uiFixture.socket.onclose()");assert.match(await text('status'),/Transmissor indisponível/);
    await screenshot('viewer-error-1160');
    for(const width of [375,768,1024,1440]){window.setContentSize(width,700);assert.equal(await noOverflow(),true,`viewer overflow at ${width}`);assert.equal(await evaluate("getComputedStyle(document.getElementById('video')).objectFit"),'contain');}
    window.setContentSize(375,700);await screenshot('viewer-error-375');
    console.log(`Native UI fixture smoke passed: logging, validation, automatic stages, P2P/relay separation, receiver states, advanced fields, reduced motion, responsive overflow. Screenshots: ${screenshots}`);
    window.destroy();app.exit(0);
  }).catch(error=>{console.error(error);app.exit(1);});
}
