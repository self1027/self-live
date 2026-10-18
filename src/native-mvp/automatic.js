const { EventEmitter } = require('node:events');
const { connectDirect } = require('./direct');
const { attachInternetViewer } = require('./internet');

const messages={
  relay_unavailable:'Nao foi possivel acessar o relay de sinalizacao nesta rede.',
  host_unavailable:'O transmissor nao esta disponivel neste convite. Confira se a captura continua ativa e copie o convite atual.',
  handshake_timeout:'O transmissor foi localizado, mas nao confirmou a entrada a tempo.',
  authentication:'O transmissor recusou o convite. Copie o convite da captura atual.',
  viewer_busy:'Esta transmissao ja tem um espectador. Feche-o antes de conectar outro.',
  tls_pin_mismatch:'O certificado recebido nao corresponde ao convite.',
  relay_rejected:'O relay recusou a entrada. Tente novamente com o convite atual.',
  dns_failed:'Nao foi possivel resolver o endereco do relay nesta rede.',
  tls_failed:'A rede nao aceitou a conexao TLS com o relay. Confira a data e a hora do PC e o acesso ao servidor.',
  negotiation_failed:'O transmissor entrou na sessao, mas nao conseguiu negociar o video.',
  timeout:'O endereco nao confirmou a conexao a tempo.',
  unavailable:'Nao foi possivel conectar por nenhum dos enderecos disponiveis.',
  closed:'A conexao com o transmissor foi encerrada.',
  invalid_message:'A sinalizacao recebida e invalida.'
};
const safeCode=code=>Object.hasOwn(messages,code)?code:'unavailable';

function attachAutomaticViewer({client,invite,onEvent=()=>{},onSample=()=>{},timeoutMs=5000,DirectViewer=connectDirect,InternetViewer=attachInternetViewer}) {
  const endpoints=[...(invite.direct?.endpoints||[]),...(invite.url?[{type:'relay',priority:3}]:[])].sort((a,b)=>a.priority-b.priority);
  let current, stopped=false, closing, selected=false, mediaConnected=false, runPromise;
  const send=value=>{if(client.readyState===1)client.send(JSON.stringify(value));};
  function stage(value,method,code){
    if(stopped)return;
    const event={type:'connection-stage',role:'receiver',stage:value,...(method?{method}:{}),...(code?{code}:{})};
    onEvent(event);send(event);
  }
  function message(raw){
    try {
      const value=JSON.parse(raw.toString());
      if(value.type==='receiver-state'){
        if(!['new','connecting','connected','disconnected','failed','closed'].includes(value.state))throw new Error();
        if(value.state==='connected'){mediaConnected=true;stage('media-connected',current?.endpoint.type);}
        else if(value.state==='connecting')stage('media-connecting',current?.endpoint.type);
        else if(['failed','disconnected'].includes(value.state))stage('failed',current?.endpoint.type,'media_'+value.state);
        return;
      }
      if(!['answer','ice','sample'].includes(value.type))throw new Error();
      if(value.type==='sample'){
        onSample(value);
        if(value.framesDecoded>0&&!mediaConnected){mediaConnected=true;stage('media-connected',current?.endpoint.type);}
      }
      if(selected&&current?.proxy.readyState===1)current.proxy.emit('message',raw);
    } catch {send({type:'error',code:'invalid_message',message:messages.invalid_message});client.close(1008);}
  }
  function close(){
    if(closing)return closing;
    stopped=true;client.off('message',message);client.off('close',closed);
    current?.fail('cancelled');
    closing=(async()=>{await current?.session?.close();await runPromise;})();return closing;
  }
  function closed(){void close();}
  client.on('message',message);client.once('close',closed);
  async function run(){
    let lastCode='unavailable';
    for(const endpoint of endpoints){
      if(stopped||client.readyState!==1)return;
      stage('trying',endpoint.type);
      const proxy=new EventEmitter();proxy.readyState=1;
      let settle, timer, settled=false, progress;
      const ready=new Promise((resolve,reject)=>{settle={resolve,reject};});
      const fail=code=>{if(settled)return;settled=true;clearTimeout(timer);settle.reject(Object.assign(new Error(),{code}));};
      const attempt=current={endpoint,proxy,fail,session:null};
      proxy.close=()=>{
        if(proxy.readyState===3)return;proxy.readyState=3;proxy.emit('close');fail('closed');
        if(selected&&!stopped)client.close(1000);
      };
      proxy.send=raw=>{
        if(proxy.readyState!==1||stopped)return;
        let value;try {value=JSON.parse(raw);}catch {fail('invalid_message');return;}
        if(!selected){
          if(value.type==='error'){fail(safeCode(value.code||'host_unavailable'));return;}
          if(value.type==='signaling-status')return;
          if(value.type!=='connecting')return;
          settled=true;clearTimeout(timer);selected=true;
          stage('connected',endpoint.type);send(value);stage('media-connecting',endpoint.type);settle.resolve();return;
        }
        if(value.type==='error')stage('failed',endpoint.type,safeCode(value.code));
        send(value);
      };
      timer=setTimeout(()=>fail(endpoint.type==='relay'?(['dns_failed','tls_failed'].includes(progress)?progress:progress==='host_found'?'handshake_timeout':progress==='relay_registered'?'host_unavailable':'relay_unavailable'):'timeout'),timeoutMs);
      try {
        attempt.session=endpoint.type==='relay'
          ? InternetViewer({client:proxy,invite,timeoutMs:timeoutMs+100,onProgress:code=>{progress=code;stage('trying','relay',code);}})
          : DirectViewer({client:proxy,endpoint,fingerprint:invite.direct.fingerprint,token:invite.token,onError:fail});
        await ready;
        return;
      } catch(error){
        clearTimeout(timer);proxy.readyState=3;proxy.emit('close');await attempt.session?.close();
        if(stopped)return;
        lastCode=safeCode(error.code);stage('failed',endpoint.type,lastCode);
        if(['authentication','viewer_busy'].includes(lastCode))break;
      }
    }
    if(!stopped){stage('failed',undefined,lastCode);send({type:'error',code:lastCode,message:messages[lastCode]});client.close(1000);}
  }
  runPromise=Promise.resolve().then(run).catch(()=>{if(!stopped){send({type:'error',code:'unavailable',message:messages.unavailable});client.close(1000);}});
  return {close};
}
module.exports={attachAutomaticViewer};
