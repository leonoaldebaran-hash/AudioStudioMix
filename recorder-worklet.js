// Captura o áudio do microfone amostra por amostra, marcando o frame exato
// do AudioContext em que cada bloco chegou. Isso permite alinhar a gravação
// com as pistas que estão tocando com precisão de amostra.
const BLOCK = 4096;

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.channelMode = 'mix'; // 'mix' | 'left' | 'right'
    this.buf = new Float32Array(BLOCK);
    this.len = 0;
    this.bufFrame = 0;
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.cmd === 'start') {
        this.channelMode = msg.channelMode || 'mix';
        this.len = 0;
        this.recording = true;
      } else if (msg.cmd === 'stop') {
        this.flush();
        this.recording = false;
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  flush() {
    if (this.len === 0) return;
    const data = this.buf.slice(0, this.len);
    this.port.postMessage({ type: 'chunk', frame: this.bufFrame, data }, [data.buffer]);
    this.len = 0;
  }

  process(inputs) {
    if (!this.recording) return true;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const l = input[0];
    const r = input.length > 1 ? input[1] : l;
    const n = l.length;
    for (let i = 0; i < n; i++) {
      if (this.len === 0) this.bufFrame = currentFrame + i;
      let s;
      if (this.channelMode === 'left') s = l[i];
      else if (this.channelMode === 'right') s = r[i];
      else s = (l[i] + r[i]) * 0.5;
      this.buf[this.len++] = s;
      if (this.len === BLOCK) this.flush();
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
