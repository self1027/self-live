const https = require('node:https');
const { X509Certificate } = require('node:crypto');
const selfsigned = require('selfsigned');
const { WebSocket, WebSocketServer } = require('ws');

function listen(server, port, host, ipv6Only = false) {
  return new Promise((resolve,reject) => {
    const failed=error=>{server.off('listening',ready);reject(error);};
    const ready=()=>{server.off('error',failed);resolve(server.address().port);};
    server.once('error',failed);server.once('listening',ready);
    server.listen({port,host,ipv6Only});
  });
}

async function createDirectServer({ accept, bind }) {
  const certificate=await selfsigned.generate([{name:'commonName',value:'Self Live'}],{keySize:2048,days:1,algorithm:'sha256'});
  const wss=new WebSocketServer({noServer:true,maxPayload:128*1024,perMessageDeflate:false});
  const servers=[], sockets=new Set(), bindings=[];
  let closing;
  const makeServer=()=>{
    const server=https.createServer({key:certificate.private,cert:certificate.cert,minVersion:'TLSv1.2'},(_request,response)=>response.writeHead(404).end());
    servers.push(server);
    server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
    server.on('upgrade',(request,socket,head)=>{
      if(closing || request.url!=='/' || request.headers.origin || wss.clients.size>=16){socket.destroy();return;}
      wss.handleUpgrade(request,socket,head,client=>{client.on('error',()=>{});accept(client);});
    });
    return server;
  };
  async function close() {
    if(closing)return closing;
    closing=(async()=>{
      const stopped=new Promise(resolve=>wss.close(resolve));
      for(const socket of wss.clients)socket.close(1000,'Transmissao encerrada');
      const deadline=setTimeout(()=>{for(const socket of sockets)socket.destroy();},600);
      try {await Promise.all([stopped,...servers.filter(server=>server.listening).map(server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}))]);}
      finally {clearTimeout(deadline);}
    })();
    return closing;
  }
  try {
    let wsPort;
    if(bind){wsPort=await listen(makeServer(),0,bind);bindings.push(bind);}
    else {
      try {wsPort=await listen(makeServer(),0,'::',true);bindings.push('::');}
      catch(error){if(!['EAFNOSUPPORT','EADDRNOTAVAIL','EPROTONOSUPPORT'].includes(error.code))throw error;}
      wsPort=await listen(makeServer(),wsPort || 0,'0.0.0.0');bindings.push('0.0.0.0');
    }
    return {wsPort,bindings,fingerprint:new X509Certificate(certificate.cert).fingerprint256,close};
  } catch(error){await close();throw error;}
}

function connectDirect({ client, endpoint, fingerprint, token, onError=()=>{} }) {
  const socket=new WebSocket(endpoint.url,{rejectUnauthorized:false,handshakeTimeout:5000,maxPayload:128*1024,perMessageDeflate:false});
  let verified=false, stopped=false, closing, failed=false;
  const fail=code=>{if(!failed&&!stopped){failed=true;onError(code);}};
  const forward=raw=>{if(verified&&socket.readyState===WebSocket.OPEN)socket.send(raw);};
  client.on('message',forward);
  socket.on('open',()=>{
    let actual;
    try {actual=new X509Certificate(socket._socket.getPeerCertificate().raw).fingerprint256.replace(/:/g,'');}catch{}
    if(actual!==fingerprint.replace(/:/g,'').toUpperCase()){fail('tls_pin_mismatch');socket.terminate();return;}
    verified=true;socket.send(JSON.stringify({type:'join',token}));
  });
  socket.on('message',raw=>{if(verified&&client.readyState===1)client.send(raw.toString());});
  socket.on('error',()=>fail('unavailable'));
  socket.on('close',()=>{fail('closed');if(client.readyState===1)client.close();});
  function close() {
    if(closing)return closing;
    stopped=true;client.off('message',forward);
    closing=new Promise(resolve=>{
      if(socket.readyState===WebSocket.CLOSED){resolve();return;}
      const deadline=setTimeout(()=>{socket.terminate();resolve();},600);
      socket.once('close',()=>{clearTimeout(deadline);resolve();});
      if(socket.readyState===WebSocket.OPEN)socket.close(1000);else socket.terminate();
    });
    return closing;
  }
  client.once('close',()=>void close());
  return {close};
}
module.exports={createDirectServer,connectDirect};
