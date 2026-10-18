const fs = require('node:fs');
const path = require('node:path');
function createNativeAudit(directory, maxBytes = 10 * 1024 * 1024) {
  let file, bytes = 0, part = 0;
  const session = new Date().toISOString().replace(/[:.]/g,'-') + '-' + process.pid;
  return {
    start(config) { file = null; bytes = 0; this.write({type:'start',schema:1,...config}); return file; },
    write(value) {
      // SDP/ICE, source lists/titles/handles and invitation tokens never enter logs.
      if (!['start','ready','sample','receiver-sample','viewer-connected','viewer-disconnected','viewer-error','source-resize','stopped','error','end','signaling-status','ice-candidates','peer-state'].includes(value.type)) return;
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
