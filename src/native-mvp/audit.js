const fs = require('node:fs');
const path = require('node:path');
let auditSequence=0;
function createNativeAudit(directory, maxBytes = 10 * 1024 * 1024) {
  let file, bytes = 0, part = 0;
  const session = new Date().toISOString().replace(/[:.]/g,'-') + '-' + process.pid + '-' + (++auditSequence);
  return {
    start(config) { file = null; bytes = 0; this.write({type:'start',schema:1,...config}); return file; },
    write(value) {
      // SDP/ICE, source lists/titles/handles and invitation tokens never enter logs.
      if (!['start','ready','sample','receiver-sample','viewer-connected','viewer-disconnected','viewer-error','source-resize','stopped','error','end','signaling-status','ice-candidates','peer-state','connection-stage','port-mapping'].includes(value.type)) return;
      if(value.type==='connection-stage'){
        if(!['trying','connected','failed','media-connecting','media-connected','closed'].includes(value.stage))return;
        value={type:value.type,role:'receiver',stage:value.stage,
          ...(['ipv6','ipv4-direct','ipv4-manual','relay','ipv4-local'].includes(value.method)?{method:value.method}:{}),
          ...(['relay_registered','host_found','relay_unavailable','host_unavailable','handshake_timeout','authentication','viewer_busy','tls_pin_mismatch','relay_rejected','dns_failed','tls_failed','negotiation_failed','timeout','unavailable','closed','invalid_message','invalid_invitation','incompatible_invitation','expired_invitation','clock_skew','media_failed','media_disconnected'].includes(value.code)?{code:value.code}:{})};
      }
      if(value.type==='port-mapping')value={type:value.type,status:['disabled','checking','mapped','unavailable'].includes(value.status)?value.status:'unavailable',
        ...(['pcp','nat-pmp','upnp'].includes(value.method)?{method:value.method}:{}),
        ...(['timeout','port_conflict','no_gateway','disabled','unsupported','invalid_configuration','unavailable'].includes(value.reason)?{reason:value.reason}:{})};
      if(value.type==='error')value={...value,message:String(value.message||'').replace(/(turns?:\/\/)[^\s]*@/gi,'$1[credenciais]@')};
      const line = JSON.stringify({time:new Date().toISOString(),...value}) + '\n';
      if (Buffer.byteLength(line) > 16384) return;
      fs.mkdirSync(directory,{recursive:true});
      if (!file || bytes + Buffer.byteLength(line) > maxBytes) {
        file = path.join(directory,`native-mvp-${session}-${++part}.jsonl`); bytes = 0;
      }
      fs.appendFileSync(file,line,{mode:0o600}); bytes += Buffer.byteLength(line);
    },
    stop() { if (file) this.write({type:'end'}); file = null; },
    file: () => file
  };
}
module.exports = { createNativeAudit };
