const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');

class NativeVideo extends EventEmitter {
  constructor({ executable, runtime, registry, launch = spawn, timeoutMs = 30000 }) {
    super();
    this.pending = new Map(); this.sequence = 0; this.timeoutMs = timeoutMs;
    this.closed = false; this.closing = null; this.stderr = '';
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    const env = { ...process.env, PATH: path.join(runtime, 'bin') + path.delimiter + process.env.PATH,
      GST_PLUGIN_PATH: path.join(runtime, 'lib/gstreamer-1.0'), GST_PLUGIN_SYSTEM_PATH_1_0: '',
      GST_PLUGIN_SCANNER: path.join(runtime, 'libexec/gstreamer-1.0/gst-plugin-scanner.exe'), GST_REGISTRY: registry,
      GIO_EXTRA_MODULES:path.join(runtime,'lib/gio/modules'),SSL_CERT_FILE:path.join(runtime,'etc/ssl/certs/ca-certificates.crt'),
      GST_DEBUG: process.env.SELF_LIVE_NATIVE_GST_DEBUG || '1', GST_DEBUG_NO_COLOR: '1' };
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve; this.rejectReady = reject;
      this.readyTimer = setTimeout(() => { reject(new Error('O motor C++ nao iniciou. Confira o runtime GStreamer.')); this.child?.kill(); }, timeoutMs);
    });
    // Keep startup failure handled even when the UI has not requested sources yet.
    this.ready.catch(() => {});
    this.child = launch(executable, [], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', () => {});
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      if (line.length > 256 * 1024) return;
      let value; try { value = JSON.parse(line); } catch { return; }
      if (value.type === 'ready') { clearTimeout(this.readyTimer); this.resolveReady(value); return; }
      if (value.type === 'response') {
        const operation = this.pending.get(value.id); if (!operation) return;
        clearTimeout(operation.timer); this.pending.delete(value.id);
        if (value.ok) operation.resolve(value); else operation.reject(new Error(value.message || 'Falha no motor C++.'));
        return;
      }
      this.emit('event', value);
    });
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-4096); });
    const fail = error => {
      clearTimeout(this.readyTimer); this.rejectReady(error);
      for (const operation of this.pending.values()) { clearTimeout(operation.timer); operation.reject(error); }
      this.pending.clear();
    };
    this.child.once('error', error => fail(new Error(error.code === 'ENOENT' ? 'Motor C++ nao compilado. Execute npm run build:native-mvp.' : 'Nao foi possivel iniciar o motor C++.')));
    this.exited = new Promise(resolve => this.child.once('close', code => {
      this.closed = true; this.lines.close(); fail(new Error(`O motor C++ encerrou (${code}).`));
      this.emit('exit', code); resolve(code);
    }));
  }
  async request(op, fields = {}) {
    await this.ready;
    if (this.closed || this.closing) throw new Error('O motor C++ foi encerrado.');
    if (this.pending.size >= 100) throw new Error('Muitas operacoes pendentes.');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timeout no motor C++ (${op}).`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...fields, id, op }) + '\n', error => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(new Error('A comunicacao com o motor C++ foi encerrada.'));
      });
    });
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.closed) return;
      this.child.stdin.end();
      const deadline = setTimeout(() => this.child.kill(), 4000);
      try { await this.exited; } finally { clearTimeout(deadline); }
    })();
    return this.closing;
  }
}
module.exports = { NativeVideo };
