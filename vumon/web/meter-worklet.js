// AudioWorklet wrapper around the shared metering DSP (secure contexts:
// HTTPS or localhost).
import { MeterDSP } from './meter-dsp.js';

class MeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.dsp = new MeterDSP(sampleRate, (r) => this.port.postMessage(r));
    this.port.onmessage = (e) => { if (e.data === 'resetI') this.dsp.resetIntegrated(); };
  }

  process(inputs) {
    this.dsp.process(inputs[0]);
    return true;
  }
}

registerProcessor('meter-processor', MeterProcessor);
