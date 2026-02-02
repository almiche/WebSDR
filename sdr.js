/**
 * WebSDR - RTL-TCP Web Client
 * Full-featured SDR client with WFM, NFM, AM demodulation
 * Waterfall and waveform visualization
 */

class RTLTCPClient {
    constructor() {
        this.ws = null;
        this.connected = false;
        this.frequency = 100000000; // 100 MHz default
        this.sampleRate = 2048000;
        this.gain = 0; // 0 = auto

        // RTL-TCP command bytes
        this.CMD_SET_FREQ = 0x01;
        this.CMD_SET_SAMPLERATE = 0x02;
        this.CMD_SET_GAIN_MODE = 0x03;
        this.CMD_SET_GAIN = 0x04;
        this.CMD_SET_FREQ_CORRECTION = 0x05;
        this.CMD_SET_IF_GAIN = 0x06;
        this.CMD_SET_TEST_MODE = 0x07;
        this.CMD_SET_AGC_MODE = 0x08;
        this.CMD_SET_DIRECT_SAMPLING = 0x09;
        this.CMD_SET_OFFSET_TUNING = 0x0A;
        this.CMD_SET_RTL_XTAL = 0x0B;
        this.CMD_SET_TUNER_XTAL = 0x0C;
        this.CMD_SET_TUNER_GAIN_BY_INDEX = 0x0D;
        this.CMD_SET_BIAS_TEE = 0x0E;
    }

    connect(host, port, secure = false) {
        return new Promise((resolve, reject) => {
            const wsProtocol = secure ? 'wss' : 'ws';
            const wsUrl = `${wsProtocol}://${host}:${port}`;
            console.log(`Connecting to ${wsUrl}`);

            this.ws = new WebSocket(wsUrl);
            this.ws.binaryType = 'arraybuffer';

            this.ws.onopen = () => {
                console.log('WebSocket connected');
                this.connected = true;
                resolve();
            };

            this.ws.onerror = (err) => {
                console.error('WebSocket error:', err);
                reject(new Error('WebSocket connection failed'));
            };

            this.ws.onclose = () => {
                console.log('WebSocket closed');
                this.connected = false;
                if (this.onDisconnect) this.onDisconnect();
            };

            this.ws.onmessage = (event) => {
                if (this.onData) {
                    this.onData(new Uint8Array(event.data));
                }
            };
        });
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
    }

    sendCommand(cmd, value) {
        if (!this.connected || !this.ws) return;

        const buffer = new ArrayBuffer(5);
        const view = new DataView(buffer);
        view.setUint8(0, cmd);
        view.setUint32(1, value, false); // Big-endian
        this.ws.send(buffer);
    }

    setFrequency(freqHz) {
        this.frequency = Math.round(freqHz);
        this.sendCommand(this.CMD_SET_FREQ, this.frequency);
        console.log(`Set frequency: ${(this.frequency / 1e6).toFixed(3)} MHz`);
    }

    setSampleRate(rate) {
        this.sampleRate = rate;
        this.sendCommand(this.CMD_SET_SAMPLERATE, rate);
        console.log(`Set sample rate: ${rate}`);
    }

    setGain(gain) {
        if (gain === 0) {
            // Enable AGC
            this.sendCommand(this.CMD_SET_AGC_MODE, 1);
            this.sendCommand(this.CMD_SET_GAIN_MODE, 0);
        } else {
            // Manual gain (value is in tenths of dB)
            this.sendCommand(this.CMD_SET_AGC_MODE, 0);
            this.sendCommand(this.CMD_SET_GAIN_MODE, 1);
            this.sendCommand(this.CMD_SET_GAIN, gain * 10);
        }
        this.gain = gain;
    }
}

class DSPProcessor {
    constructor(sampleRate) {
        this.sampleRate = sampleRate;
        this.mode = 'wfm';
        this.squelch = 0;
        this.filterBandwidth = 200000; // Start with WFM bandwidth

        // Demodulation state
        this.lastI = 0;
        this.lastQ = 0;
        this.fmPhase = 0;

        // Audio state
        this.audioSampleRate = 48000;
        this.decimationFactor = Math.floor(sampleRate / this.audioSampleRate);

        // FM deviation - broadcast FM uses ±75 kHz, NFM uses ±5 kHz
        this.fmDeviation = 75000; // Hz

        // De-emphasis filter state (for FM broadcast - 75µs for NA, 50µs for EU)
        // Using a gentler de-emphasis for cleaner sound
        this.deemphState = 0;
        const tau = 75e-6; // 75 microseconds time constant
        this.deemphAlpha = 1.0 / (1.0 + this.audioSampleRate * tau);

        // IQ low-pass filter for pre-demodulation filtering
        this.numFilterTaps = 63;
        this.iqLpfCoeffs = this.designLPF(this.filterBandwidth);
        this.iqLpfBufferI = new Float32Array(this.numFilterTaps);
        this.iqLpfBufferQ = new Float32Array(this.numFilterTaps);
        this.iqLpfIndex = 0;

        // Audio low-pass filter (for after demodulation) - 12 kHz for smoother audio
        this.audioLpfCoeffs = this.designAudioLPF(12000);
        this.audioLpfBuffer = new Float32Array(this.audioLpfCoeffs.length);
        this.audioLpfIndex = 0;

        // DC blocker
        this.dcBlockerState = 0;
        this.dcBlockerAlpha = 0.995;

        // AM AGC (Automatic Gain Control)
        this.amAgcGain = 1.0;
        this.amAgcAttack = 0.01;  // Fast attack
        this.amAgcDecay = 0.0001; // Slow decay
        this.amAgcTarget = 0.5;   // Target output level

        // AM carrier tracking for better demodulation
        this.amDcAvg = 0;
        this.amDcAlpha = 0.001; // Slow DC tracking for carrier

        // DC spike removal (RTL-SDR has a spike at center frequency)
        this.dcRemovalAlpha = 0.9999; // Very slow tracking
        this.dcAvgI = 0;
        this.dcAvgQ = 0;

        // IQ imbalance correction
        this.iqGainCorrection = 1.0;  // Amplitude imbalance
        this.iqPhaseCorrection = 0.0; // Phase imbalance (radians)

        // Noise floor estimation for better squelch
        this.noiseFloor = 0;
        this.noiseAlpha = 0.001;

        // Squelch state (with hysteresis)
        this.squelchOpen = true;

        // FM integrator for better demod (accumulates phase)
        this.fmIntegrator = 0;
    }

    setMode(mode) {
        this.mode = mode;
        switch (mode) {
            case 'wfm':
                this.filterBandwidth = 200000; // Full WFM bandwidth (~200 kHz)
                this.fmDeviation = 75000; // ±75 kHz for broadcast FM
                this.decimationFactor = Math.floor(this.sampleRate / this.audioSampleRate);
                this.numFilterTaps = 127; // More taps for WFM
                break;
            case 'nfm':
                this.filterBandwidth = 12500; // NFM channel spacing
                this.fmDeviation = 5000; // ±5 kHz for NFM
                this.decimationFactor = Math.floor(this.sampleRate / this.audioSampleRate);
                this.numFilterTaps = 63;
                break;
            case 'am':
                this.filterBandwidth = 10000;
                this.decimationFactor = Math.floor(this.sampleRate / this.audioSampleRate);
                this.numFilterTaps = 63;
                break;
        }
        // Update IQ filter
        this.iqLpfCoeffs = this.designLPF(this.filterBandwidth);
        this.iqLpfBufferI = new Float32Array(this.numFilterTaps);
        this.iqLpfBufferQ = new Float32Array(this.numFilterTaps);
        this.iqLpfIndex = 0;
        // Reset demod state
        this.lastI = 0;
        this.lastQ = 0;
        this.fmIntegrator = 0;
    }

    setSquelch(level) {
        this.squelch = level;
    }

    setSampleRate(rate) {
        this.sampleRate = rate;
        this.decimationFactor = Math.max(1, Math.floor(rate / this.audioSampleRate));
        this.setMode(this.mode); // Recalculate filters
    }

    designLPF(cutoff) {
        const numTaps = this.numFilterTaps || 63;
        const coeffs = new Float32Array(numTaps);
        // Normalize cutoff to Nyquist frequency
        const fc = Math.min(0.45, cutoff / this.sampleRate);
        const middle = Math.floor(numTaps / 2);

        for (let i = 0; i < numTaps; i++) {
            const n = i - middle;
            if (n === 0) {
                coeffs[i] = 2 * fc;
            } else {
                coeffs[i] = Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
            }
            // Blackman window (better stopband attenuation than Hamming)
            const w = 2 * Math.PI * i / (numTaps - 1);
            coeffs[i] *= 0.42 - 0.5 * Math.cos(w) + 0.08 * Math.cos(2 * w);
        }

        // Normalize
        const sum = coeffs.reduce((a, b) => a + b, 0);
        for (let i = 0; i < numTaps; i++) {
            coeffs[i] /= sum;
        }

        return coeffs;
    }

    designAudioLPF(cutoff) {
        const numTaps = 31;
        const coeffs = new Float32Array(numTaps);
        const fc = cutoff / this.audioSampleRate;
        const middle = Math.floor(numTaps / 2);

        for (let i = 0; i < numTaps; i++) {
            const n = i - middle;
            if (n === 0) {
                coeffs[i] = 2 * fc;
            } else {
                coeffs[i] = Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
            }
            // Hamming window
            coeffs[i] *= 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (numTaps - 1));
        }

        // Normalize
        const sum = coeffs.reduce((a, b) => a + b, 0);
        for (let i = 0; i < numTaps; i++) {
            coeffs[i] /= sum;
        }

        return coeffs;
    }

    applyAudioLPF(sample) {
        this.audioLpfBuffer[this.audioLpfIndex] = sample;
        let output = 0;
        let idx = this.audioLpfIndex;

        for (let i = 0; i < this.audioLpfCoeffs.length; i++) {
            output += this.audioLpfBuffer[idx] * this.audioLpfCoeffs[i];
            idx--;
            if (idx < 0) idx = this.audioLpfCoeffs.length - 1;
        }

        this.audioLpfIndex = (this.audioLpfIndex + 1) % this.audioLpfCoeffs.length;
        return output;
    }

    applyIQFilter(sampleI, sampleQ) {
        // Store samples in circular buffer
        this.iqLpfBufferI[this.iqLpfIndex] = sampleI;
        this.iqLpfBufferQ[this.iqLpfIndex] = sampleQ;

        let outputI = 0;
        let outputQ = 0;
        let idx = this.iqLpfIndex;

        for (let i = 0; i < this.iqLpfCoeffs.length; i++) {
            outputI += this.iqLpfBufferI[idx] * this.iqLpfCoeffs[i];
            outputQ += this.iqLpfBufferQ[idx] * this.iqLpfCoeffs[i];
            idx--;
            if (idx < 0) idx = this.iqLpfCoeffs.length - 1;
        }

        this.iqLpfIndex = (this.iqLpfIndex + 1) % this.iqLpfCoeffs.length;
        return { i: outputI, q: outputQ };
    }

    dcBlocker(sample) {
        const output = sample - this.dcBlockerState + this.dcBlockerAlpha * this.dcBlockerState;
        this.dcBlockerState = sample;
        return output;
    }

    deemphasis(sample) {
        // Simple first-order IIR low-pass filter for de-emphasis
        this.deemphState = this.deemphAlpha * sample + (1 - this.deemphAlpha) * this.deemphState;
        return this.deemphState;
    }

    // Convert unsigned 8-bit IQ samples to float with corrections
    processIQ(data) {
        const numSamples = Math.floor(data.length / 2);
        const iq = new Float32Array(numSamples * 2);

        for (let i = 0; i < numSamples; i++) {
            // Convert to float (-1 to 1)
            let I = (data[i * 2] - 127.5) / 127.5;
            let Q = (data[i * 2 + 1] - 127.5) / 127.5;

            // DC spike removal - track and subtract DC offset
            this.dcAvgI = this.dcRemovalAlpha * this.dcAvgI + (1 - this.dcRemovalAlpha) * I;
            this.dcAvgQ = this.dcRemovalAlpha * this.dcAvgQ + (1 - this.dcRemovalAlpha) * Q;
            I -= this.dcAvgI;
            Q -= this.dcAvgQ;

            // IQ imbalance correction (amplitude and phase)
            // Corrects for hardware imperfections in RTL-SDR
            Q = Q * this.iqGainCorrection;
            const correctedQ = Q + I * this.iqPhaseCorrection;

            iq[i * 2] = I;
            iq[i * 2 + 1] = correctedQ;
        }

        return iq;
    }

    // FM demodulation using arctangent differentiation
    demodulateFM(iq) {
        const numSamples = iq.length / 2;
        const audio = new Float32Array(Math.floor(numSamples / this.decimationFactor));
        let audioIdx = 0;

        // FM gain - normalize based on sample rate and deviation
        // Lower gain for cleaner audio
        const fmGain = this.sampleRate / (2 * Math.PI * this.fmDeviation) * 0.5;

        for (let i = 0; i < numSamples; i++) {
            const currentI = iq[i * 2];
            const currentQ = iq[i * 2 + 1];

            // Quadrature demodulation (polar discriminator)
            // This computes the phase difference between consecutive samples
            const diffI = currentI * this.lastI + currentQ * this.lastQ;
            const diffQ = currentQ * this.lastI - currentI * this.lastQ;

            // Phase difference (instantaneous frequency)
            let demod = Math.atan2(diffQ, diffI);

            this.lastI = currentI;
            this.lastQ = currentQ;

            // Decimate to audio rate
            if (i % this.decimationFactor === 0 && audioIdx < audio.length) {
                // Scale by FM gain
                demod *= fmGain;

                // Apply de-emphasis for broadcast FM (75µs time constant)
                if (this.mode === 'wfm') {
                    demod = this.deemphasis(demod);
                }

                // Apply audio low-pass filter to remove high frequency noise
                demod = this.applyAudioLPF(demod);

                // DC blocker to remove any DC offset
                demod = this.dcBlocker(demod);

                // Soft limiting for cleaner audio
                const limited = Math.tanh(demod * 1.5);
                audio[audioIdx++] = limited * 0.7;
            }
        }

        return audio;
    }

    // AM demodulation using envelope detection with AGC
    demodulateAM(iq) {
        const numSamples = iq.length / 2;
        const audio = new Float32Array(Math.floor(numSamples / this.decimationFactor));
        let audioIdx = 0;

        // Accumulator for decimation averaging
        let magSum = 0;
        let magCount = 0;

        for (let i = 0; i < numSamples; i++) {
            let I = iq[i * 2];
            let Q = iq[i * 2 + 1];

            // Apply IQ low-pass filter before demodulation
            const filtered = this.applyIQFilter(I, Q);
            I = filtered.i;
            Q = filtered.q;

            // Envelope detection (magnitude of IQ signal)
            const magnitude = Math.sqrt(I * I + Q * Q);

            // Accumulate for decimation
            magSum += magnitude;
            magCount++;

            // Decimate to audio rate by averaging
            if (magCount >= this.decimationFactor && audioIdx < audio.length) {
                const avgMag = magSum / magCount;

                // Track the DC/carrier level (slow average)
                this.amDcAvg = this.amDcAvg * (1 - this.amDcAlpha) + avgMag * this.amDcAlpha;

                // Remove the carrier (DC component) to get audio
                let audioSample = avgMag - this.amDcAvg;

                // Apply AGC
                const absVal = Math.abs(audioSample);
                if (absVal > this.amAgcTarget / this.amAgcGain) {
                    // Signal too loud - fast attack
                    this.amAgcGain *= (1 - this.amAgcAttack);
                } else {
                    // Signal quiet - slow decay (increase gain)
                    this.amAgcGain *= (1 + this.amAgcDecay);
                }
                // Clamp gain to reasonable range
                this.amAgcGain = Math.max(0.1, Math.min(100, this.amAgcGain));

                // Apply gain
                audioSample *= this.amAgcGain;

                // Apply audio low-pass filter
                audioSample = this.applyAudioLPF(audioSample);

                // Final clipping protection
                audio[audioIdx++] = Math.max(-1, Math.min(1, audioSample));

                // Reset accumulator
                magSum = 0;
                magCount = 0;
            }
        }

        return audio;
    }

    process(data) {
        const iq = this.processIQ(data);
        let audio;

        switch (this.mode) {
            case 'wfm':
            case 'nfm':
                audio = this.demodulateFM(iq);
                break;
            case 'am':
                audio = this.demodulateAM(iq);
                break;
            default:
                audio = this.demodulateFM(iq);
        }

        // Apply squelch with hysteresis to prevent choppy audio
        if (this.squelch > 0) {
            const rms = Math.sqrt(audio.reduce((sum, s) => sum + s * s, 0) / audio.length);
            const threshold = this.squelch / 1000;
            const hysteresis = threshold * 0.3; // 30% hysteresis

            if (!this.squelchOpen) {
                // Squelch is closed - need signal above threshold + hysteresis to open
                if (rms > threshold + hysteresis) {
                    this.squelchOpen = true;
                }
            } else {
                // Squelch is open - signal must drop below threshold - hysteresis to close
                if (rms < threshold - hysteresis) {
                    this.squelchOpen = false;
                }
            }

            if (!this.squelchOpen) {
                // Fade out smoothly instead of hard cut
                for (let i = 0; i < audio.length; i++) {
                    audio[i] *= Math.max(0, 1 - i / audio.length);
                }
            }
        } else {
            this.squelchOpen = true;
        }

        return { iq, audio };
    }
}

class Visualizer {
    constructor(spectrumCanvas, waterfallCanvas, waveformCanvas) {
        this.spectrumCanvas = spectrumCanvas;
        this.waterfallCanvas = waterfallCanvas;
        this.waveformCanvas = waveformCanvas;
        this.spectrumCtx = spectrumCanvas.getContext('2d');
        this.waterfallCtx = waterfallCanvas.getContext('2d');
        this.waveformCtx = waveformCanvas.getContext('2d');

        this.fftSize = 4096; // Increased from 2048 for better frequency resolution
        this.waterfallData = [];
        this.maxWaterfallLines = 400; // Increased for more granular waterfall

        // Spectrum display range (in dB, relative to FFT output)
        this.spectrumMin = -80; // dB floor
        this.spectrumMax = 0;   // dB ceiling

        // Frequency information for grid lines
        this.centerFrequency = 100e6; // Hz
        this.sampleRate = 2048000;    // Hz (determines visible bandwidth)

        // FFT averaging for smoother spectrum display (like SDR++)
        this.fftAverageCount = 4; // Number of frames to average
        this.fftAverageBuffer = null; // Will hold averaged spectrum
        this.fftFrameCount = 0;

        // Pre-rendered waterfall buffer (stores data with frequency metadata)
        // Each entry: { fftMag: Float32Array, centerFreq: number }
        this.waterfallBuffer = [];
        this.maxBufferLines = 600; // Keep more lines in buffer for panning

        // Off-screen canvas for smooth rendering
        this.offscreenCanvas = document.createElement('canvas');
        this.offscreenCtx = this.offscreenCanvas.getContext('2d');

        // Color palette for waterfall (blue to red to white)
        this.colorPalette = this.createColorPalette();

        // Pre-compute color palette as ImageData-compatible values for speed
        this.colorPaletteRGBA = this.createColorPaletteRGBA();

        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    setFrequencyInfo(centerFreqHz, sampleRate) {
        this.centerFrequency = centerFreqHz;
        this.sampleRate = sampleRate;
    }

    createColorPaletteRGBA() {
        const palette = new Array(256);
        for (let i = 0; i < 256; i++) {
            const ratio = i / 255;
            let r, g, b;

            if (ratio < 0.2) {
                const t = ratio / 0.2;
                r = 0; g = 0; b = Math.floor(t * 100);
            } else if (ratio < 0.4) {
                const t = (ratio - 0.2) / 0.2;
                r = 0; g = 0; b = 100 + Math.floor(t * 155);
            } else if (ratio < 0.55) {
                const t = (ratio - 0.4) / 0.15;
                r = 0; g = Math.floor(t * 255); b = 255;
            } else if (ratio < 0.7) {
                const t = (ratio - 0.55) / 0.15;
                r = 0; g = 255; b = Math.floor((1 - t) * 255);
            } else if (ratio < 0.85) {
                const t = (ratio - 0.7) / 0.15;
                r = Math.floor(t * 255); g = 255; b = 0;
            } else {
                const t = (ratio - 0.85) / 0.15;
                r = 255; g = Math.floor(255 - t * 128); b = Math.floor(t * 255);
            }

            palette[i] = { r, g, b };
        }
        return palette;
    }

    setSpectrumRange(min, max) {
        this.spectrumMin = min;
        this.spectrumMax = max;
    }

    clearWaterfall() {
        this.waterfallData = [];
        this.waterfallBuffer = [];
        // Clear the waterfall canvas
        const ctx = this.waterfallCtx;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, this.waterfallCanvas.width, this.waterfallCanvas.height);
        // Clear offscreen canvas
        this.offscreenCtx.fillStyle = '#000';
        this.offscreenCtx.fillRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);
        // Reset FFT averaging buffer
        this.fftAverageBuffer = null;
        this.fftFrameCount = 0;
    }

    createColorPalette() {
        const palette = new Array(256);
        for (let i = 0; i < 256; i++) {
            const ratio = i / 255;
            let r, g, b;

            if (ratio < 0.2) {
                // Black to dark blue (noise floor)
                const t = ratio / 0.2;
                r = 0;
                g = 0;
                b = Math.floor(t * 100);
            } else if (ratio < 0.4) {
                // Dark blue to blue
                const t = (ratio - 0.2) / 0.2;
                r = 0;
                g = 0;
                b = 100 + Math.floor(t * 155);
            } else if (ratio < 0.55) {
                // Blue to cyan
                const t = (ratio - 0.4) / 0.15;
                r = 0;
                g = Math.floor(t * 255);
                b = 255;
            } else if (ratio < 0.7) {
                // Cyan to green
                const t = (ratio - 0.55) / 0.15;
                r = 0;
                g = 255;
                b = Math.floor((1 - t) * 255);
            } else if (ratio < 0.85) {
                // Green to yellow
                const t = (ratio - 0.7) / 0.15;
                r = Math.floor(t * 255);
                g = 255;
                b = 0;
            } else {
                // Yellow to red to white (strong signals)
                const t = (ratio - 0.85) / 0.15;
                r = 255;
                g = Math.floor(255 - t * 128);
                b = Math.floor(t * 255);
            }

            palette[i] = `rgb(${r},${g},${b})`;
        }
        return palette;
    }

    resize() {
        const spectrumRect = this.spectrumCanvas.parentElement.getBoundingClientRect();
        const waterfallRect = this.waterfallCanvas.parentElement.getBoundingClientRect();
        const waveformRect = this.waveformCanvas.parentElement.getBoundingClientRect();

        this.spectrumCanvas.width = spectrumRect.width;
        this.spectrumCanvas.height = spectrumRect.height;

        this.waterfallCanvas.width = waterfallRect.width;
        this.waterfallCanvas.height = waterfallRect.height - 20; // Leave room for scale

        this.waveformCanvas.width = waveformRect.width;
        this.waveformCanvas.height = waveformRect.height;

        // Resize offscreen canvas to match (with extra width for pre-rendering)
        this.offscreenCanvas.width = waterfallRect.width * 3; // 3x width for left/right buffer
        this.offscreenCanvas.height = waterfallRect.height - 20;
    }

    drawWaterfall(iq) {
        if (!iq || iq.length < this.fftSize * 2) return;

        // Compute FFT magnitude (returns dB values)
        const fftMag = this.computeFFT(iq);

        // Store FFT data with frequency metadata in buffer
        if (this.waterfallBuffer.length >= this.maxBufferLines) {
            this.waterfallBuffer.shift();
        }
        this.waterfallBuffer.push({
            fftMag: fftMag,
            centerFreq: this.centerFrequency,
            sampleRate: this.sampleRate
        });

        // Also maintain legacy waterfallData for compatibility
        if (this.waterfallData.length >= this.maxWaterfallLines) {
            this.waterfallData.shift();
        }
        this.waterfallData.push(fftMag);

        // Draw waterfall using ImageData for better performance
        const ctx = this.waterfallCtx;
        const width = this.waterfallCanvas.width;
        const height = this.waterfallCanvas.height;

        // Create ImageData for the entire waterfall
        const imageData = ctx.createImageData(width, height);
        const data = imageData.data;

        const lineHeight = Math.max(1, Math.ceil(height / this.maxWaterfallLines));
        const range = this.spectrumMax - this.spectrumMin;

        // Current view frequency range
        const viewStartFreq = this.centerFrequency - this.sampleRate / 2;
        const viewEndFreq = this.centerFrequency + this.sampleRate / 2;

        // Render waterfall lines with frequency-aware positioning
        for (let y = 0; y < this.waterfallBuffer.length; y++) {
            const entry = this.waterfallBuffer[y];
            const line = entry.fftMag;
            const lineStartFreq = entry.centerFreq - entry.sampleRate / 2;
            const lineEndFreq = entry.centerFreq + entry.sampleRate / 2;

            const pixelY = Math.floor(height - (y + 1) * lineHeight);
            if (pixelY < 0 || pixelY >= height) continue;

            // Draw multiple pixel rows for line height
            for (let ly = 0; ly < lineHeight && (pixelY + ly) < height; ly++) {
                const rowY = pixelY + ly;
                if (rowY < 0) continue;

                for (let x = 0; x < width; x++) {
                    // Map screen x to frequency
                    const freq = viewStartFreq + (x / width) * this.sampleRate;

                    // Check if this frequency is within the stored line's range
                    if (freq >= lineStartFreq && freq <= lineEndFreq) {
                        // Map frequency to bin index in stored FFT data
                        const binRatio = (freq - lineStartFreq) / entry.sampleRate;
                        const binIndex = Math.floor(binRatio * line.length);

                        if (binIndex >= 0 && binIndex < line.length) {
                            const dB = line[binIndex];
                            const normalized = (dB - this.spectrumMin) / range;
                            const colorIdx = Math.min(255, Math.max(0, Math.floor(normalized * 255)));
                            const color = this.colorPaletteRGBA[colorIdx];

                            const idx = (rowY * width + x) * 4;
                            data[idx] = color.r;
                            data[idx + 1] = color.g;
                            data[idx + 2] = color.b;
                            data[idx + 3] = 255;
                        }
                    }
                    // Frequencies outside stored range remain black (already 0)
                }
            }
        }

        ctx.putImageData(imageData, 0, 0);

        // Draw 100 kHz grid lines on waterfall
        this.drawWaterfallGrid(ctx, width, height);

        // Draw spectrum on its own canvas
        this.drawSpectrum(fftMag);
    }

    drawWaterfallGrid(ctx, width, height) {
        const bandwidth = this.sampleRate;
        const startFreq = this.centerFrequency - bandwidth / 2;
        const endFreq = this.centerFrequency + bandwidth / 2;
        const gridSpacing = 100000; // 100 kHz

        // Find first grid line position (round up to nearest 100 kHz)
        const firstGridFreq = Math.ceil(startFreq / gridSpacing) * gridSpacing;

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.setLineDash([2, 4]); // Dashed line for waterfall

        for (let freq = firstGridFreq; freq <= endFreq; freq += gridSpacing) {
            const x = ((freq - startFreq) / bandwidth) * width;

            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        }

        ctx.setLineDash([]); // Reset dash pattern
    }

    drawSpectrum(fftMag) {
        const ctx = this.spectrumCtx;
        const width = this.spectrumCanvas.width;
        const height = this.spectrumCanvas.height;
        const range = this.spectrumMax - this.spectrumMin;

        // Clear with dark background
        ctx.fillStyle = '#0a0a14';
        ctx.fillRect(0, 0, width, height);

        // Draw horizontal grid lines with dB labels
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.font = '10px monospace';
        ctx.lineWidth = 1;

        const numGridLines = 5;
        for (let i = 0; i <= numGridLines; i++) {
            const dB = this.spectrumMin + (range * i / numGridLines);
            const y = height - (i / numGridLines) * height;

            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();

            // Draw dB label
            ctx.fillText(`${dB.toFixed(0)} dB`, 5, y - 3);
        }

        // Draw vertical frequency grid lines at 100 kHz intervals
        const bandwidth = this.sampleRate; // Total visible bandwidth
        const startFreq = this.centerFrequency - bandwidth / 2;
        const endFreq = this.centerFrequency + bandwidth / 2;
        const gridSpacing = 100000; // 100 kHz

        // Find first grid line position (round up to nearest 100 kHz)
        const firstGridFreq = Math.ceil(startFreq / gridSpacing) * gridSpacing;

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.font = '9px monospace';
        ctx.textAlign = 'center';

        for (let freq = firstGridFreq; freq <= endFreq; freq += gridSpacing) {
            // Calculate x position
            const x = ((freq - startFreq) / bandwidth) * width;

            // Draw vertical line
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();

            // Draw frequency label at bottom
            const freqMHz = freq / 1e6;
            const label = freqMHz >= 1000 ? `${(freqMHz / 1000).toFixed(2)}G` : `${freqMHz.toFixed(1)}`;
            ctx.fillText(label, x, height - 5);
        }

        ctx.textAlign = 'left'; // Reset text alignment

        // Draw spectrum line
        ctx.strokeStyle = 'rgba(100, 255, 218, 0.9)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();

        for (let x = 0; x < width; x++) {
            const binIndex = Math.floor(x / width * fftMag.length);
            const dB = fftMag[binIndex];
            // Map dB to screen position using min/max
            const normalized = (dB - this.spectrumMin) / range;
            const y = height - Math.max(0, Math.min(1, normalized)) * height;

            if (x === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }

        ctx.stroke();

        // Draw filled area under the spectrum with gradient
        const gradient = ctx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, 'rgba(100, 255, 218, 0.3)');
        gradient.addColorStop(1, 'rgba(100, 255, 218, 0.05)');

        ctx.lineTo(width, height);
        ctx.lineTo(0, height);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();
    }

    computeFFT(iq) {
        const N = this.fftSize;
        const real = new Float32Array(N);
        const imag = new Float32Array(N);

        // Copy IQ data and apply Blackman-Harris window (better dynamic range than Hanning)
        for (let i = 0; i < N && i * 2 + 1 < iq.length; i++) {
            const a0 = 0.35875, a1 = 0.48829, a2 = 0.14128, a3 = 0.01168;
            const x = 2 * Math.PI * i / (N - 1);
            const window = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x) - a3 * Math.cos(3 * x);
            real[i] = iq[i * 2] * window;
            imag[i] = iq[i * 2 + 1] * window;
        }

        // Cooley-Tukey FFT
        this.fft(real, imag);

        // Compute magnitude in dB (proper dBFS scale)
        const magnitude = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            // Rearrange for center DC
            const idx = (i + N / 2) % N;
            const mag = Math.sqrt(real[idx] * real[idx] + imag[idx] * imag[idx]) / N;
            // Convert to dB with proper scaling (0 dB = full scale)
            magnitude[i] = 20 * Math.log10(Math.max(mag, 1e-10));
        }

        // Apply FFT averaging for smoother display
        if (!this.fftAverageBuffer || this.fftAverageBuffer.length !== N) {
            this.fftAverageBuffer = new Float32Array(magnitude);
            this.fftFrameCount = 1;
        } else {
            // Exponential moving average for smooth response
            const alpha = 0.3; // Higher = more responsive, lower = smoother
            for (let i = 0; i < N; i++) {
                this.fftAverageBuffer[i] = alpha * magnitude[i] + (1 - alpha) * this.fftAverageBuffer[i];
            }
        }

        return this.fftAverageBuffer;
    }

    fft(real, imag) {
        const N = real.length;

        // Bit reversal
        let j = 0;
        for (let i = 0; i < N - 1; i++) {
            if (i < j) {
                [real[i], real[j]] = [real[j], real[i]];
                [imag[i], imag[j]] = [imag[j], imag[i]];
            }
            let k = N >> 1;
            while (k <= j) {
                j -= k;
                k >>= 1;
            }
            j += k;
        }

        // FFT computation
        for (let len = 2; len <= N; len <<= 1) {
            const halfLen = len >> 1;
            const angle = -2 * Math.PI / len;

            for (let i = 0; i < N; i += len) {
                for (let k = 0; k < halfLen; k++) {
                    const theta = angle * k;
                    const wr = Math.cos(theta);
                    const wi = Math.sin(theta);

                    const idx1 = i + k;
                    const idx2 = i + k + halfLen;

                    const tr = real[idx2] * wr - imag[idx2] * wi;
                    const ti = real[idx2] * wi + imag[idx2] * wr;

                    real[idx2] = real[idx1] - tr;
                    imag[idx2] = imag[idx1] - ti;
                    real[idx1] += tr;
                    imag[idx1] += ti;
                }
            }
        }
    }

    drawWaveform(audio) {
        const ctx = this.waveformCtx;
        const width = this.waveformCanvas.width;
        const height = this.waveformCanvas.height;

        // Clear
        ctx.fillStyle = '#16213e';
        ctx.fillRect(0, 0, width, height);

        // Draw center line
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();

        // Draw waveform
        ctx.strokeStyle = '#4ade80';
        ctx.lineWidth = 2;
        ctx.beginPath();

        const step = Math.ceil(audio.length / width);

        for (let x = 0; x < width; x++) {
            const idx = Math.floor(x * audio.length / width);
            const sample = audio[idx] || 0;
            const y = (height / 2) - (sample * height * 0.4);

            if (x === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }

        ctx.stroke();
    }
}

class AudioPlayer {
    constructor() {
        this.audioCtx = null;
        this.gainNode = null;
        this.playing = false;
        this.volume = 0.5;

        this.bufferQueue = [];
        this.nextStartTime = 0;
        this.bufferDuration = 0.1; // 100ms buffers

        // Recording state
        this.isRecording = false;
        this.recordedChunks = [];
        this.recordingStartTime = null;
    }

    async init() {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 48000
        });

        this.gainNode = this.audioCtx.createGain();
        this.gainNode.gain.value = this.volume;
        this.gainNode.connect(this.audioCtx.destination);

        // Resume context if suspended
        if (this.audioCtx.state === 'suspended') {
            await this.audioCtx.resume();
        }
    }

    play(audioData) {
        if (!this.audioCtx || !this.playing) return;

        // Add to recording if active
        this.addRecordingData(audioData);

        const buffer = this.audioCtx.createBuffer(1, audioData.length, 48000);
        buffer.getChannelData(0).set(audioData);

        const source = this.audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.gainNode);

        const now = this.audioCtx.currentTime;

        // Schedule playback
        if (this.nextStartTime < now) {
            this.nextStartTime = now + 0.02; // Small delay to prevent clicks
        }

        source.start(this.nextStartTime);
        this.nextStartTime += buffer.duration;
    }

    setVolume(volume) {
        this.volume = volume;
        if (this.gainNode) {
            this.gainNode.gain.value = volume;
        }
    }

    start() {
        this.playing = true;
        this.nextStartTime = 0;
    }

    stop() {
        this.playing = false;
    }

    getRMS(audioData) {
        if (!audioData || audioData.length === 0) return 0;
        const sum = audioData.reduce((acc, s) => acc + s * s, 0);
        return Math.sqrt(sum / audioData.length);
    }

    // Recording functions
    startRecording() {
        this.isRecording = true;
        this.recordedChunks = [];
        this.recordingStartTime = Date.now();
        console.log('Recording started');
    }

    stopRecording() {
        this.isRecording = false;
        console.log('Recording stopped');
        return this.exportRecording();
    }

    addRecordingData(audioData) {
        if (this.isRecording && audioData && audioData.length > 0) {
            // Clone the data since it might be reused
            this.recordedChunks.push(new Float32Array(audioData));
        }
    }

    getRecordingDuration() {
        if (!this.recordingStartTime) return 0;
        return (Date.now() - this.recordingStartTime) / 1000;
    }

    exportRecording() {
        if (this.recordedChunks.length === 0) {
            console.warn('No audio recorded');
            return null;
        }

        // Calculate total length
        const totalLength = this.recordedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const sampleRate = 48000;

        // Merge all chunks
        const mergedAudio = new Float32Array(totalLength);
        let offset = 0;
        for (const chunk of this.recordedChunks) {
            mergedAudio.set(chunk, offset);
            offset += chunk.length;
        }

        // Create WAV file
        const wavBlob = this.createWavBlob(mergedAudio, sampleRate);

        // Generate filename with timestamp
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `recording_${timestamp}.wav`;

        // Download the file
        const url = URL.createObjectURL(wavBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log(`Exported ${(totalLength / sampleRate).toFixed(1)}s of audio as ${filename}`);

        // Clear recorded data
        this.recordedChunks = [];
        this.recordingStartTime = null;

        return filename;
    }

    createWavBlob(audioData, sampleRate) {
        const numChannels = 1;
        const bitsPerSample = 16;
        const bytesPerSample = bitsPerSample / 8;
        const blockAlign = numChannels * bytesPerSample;
        const byteRate = sampleRate * blockAlign;
        const dataSize = audioData.length * bytesPerSample;
        const headerSize = 44;
        const totalSize = headerSize + dataSize;

        const buffer = new ArrayBuffer(totalSize);
        const view = new DataView(buffer);

        // Write WAV header
        const writeString = (offset, str) => {
            for (let i = 0; i < str.length; i++) {
                view.setUint8(offset + i, str.charCodeAt(i));
            }
        };

        writeString(0, 'RIFF');
        view.setUint32(4, totalSize - 8, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true); // fmt chunk size
        view.setUint16(20, 1, true);  // PCM format
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitsPerSample, true);
        writeString(36, 'data');
        view.setUint32(40, dataSize, true);

        // Write audio data (convert float to 16-bit PCM)
        let offset = 44;
        for (let i = 0; i < audioData.length; i++) {
            // Clamp to [-1, 1] and convert to 16-bit signed integer
            const sample = Math.max(-1, Math.min(1, audioData[i]));
            const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            view.setInt16(offset, int16, true);
            offset += 2;
        }

        return new Blob([buffer], { type: 'audio/wav' });
    }
}

// Main Application
class WebSDRApp {
    constructor() {
        this.rtl = new RTLTCPClient();
        this.dsp = new DSPProcessor(2048000);
        this.visualizer = null;
        this.audio = new AudioPlayer();

        this.currentMode = 'wfm';
        this.isConnected = false;
        this.isPlaying = false;

        this.dataBuffer = new Uint8Array(0);
        this.processInterval = null;

        // Frequency control state
        this.frequencyStep = 0.1; // Default step in MHz
        this.isDragging = false;
        this.dragStartX = 0;
        this.dragStartFreq = 0;

        // SDR++ style: centerFreq is the display center, tuneOffset is where the red line is
        this.centerFrequency = 100.0; // MHz - center of the display
        this.tuneOffset = 0; // Hz offset from center where we're tuned
        this.indicatorPosition = 50; // Percentage position of the indicator (0-100)

        // Throttle timer for RTL updates during dragging
        this.rtlUpdateTimer = null;
        this.lastRtlUpdateFreq = 100.0;

        // Recording state
        this.isRecording = false;
        this.recordingTimer = null;

        this.init();
    }

    init() {
        // Initialize visualizer with all three canvases
        const spectrumCanvas = document.getElementById('spectrumCanvas');
        const waterfallCanvas = document.getElementById('waterfallCanvas');
        const waveformCanvas = document.getElementById('waveformCanvas');
        this.visualizer = new Visualizer(spectrumCanvas, waterfallCanvas, waveformCanvas);

        // Bind UI events
        this.bindEvents();

        // Initialize frequency from input
        const initialFreq = parseFloat(document.getElementById('frequencyDisplay').value);
        this.centerFrequency = initialFreq;
        this.tuneOffset = 0;
        this.indicatorPosition = 50;

        // Update displays
        this.updateFrequencyDisplay(initialFreq);
        this.updateIndicatorPosition();
        this.updateFreqScale();

        // Initialize bookmark system
        this.initBookmarks();
    }

    bindEvents() {
        // Connect button
        document.getElementById('connectBtn').addEventListener('click', () => {
            if (this.isConnected) {
                this.disconnect();
            } else {
                this.connect();
            }
        });

        // Play button
        document.getElementById('playBtn').addEventListener('click', () => {
            this.toggleAudio();
        });

        // Record button
        document.getElementById('recordBtn').addEventListener('click', () => {
            this.toggleRecording();
        });

        // Main frequency display input (the big red one)
        const freqDisplay = document.getElementById('frequencyDisplay');
        let freqInputTimeout = null;

        // Auto-update while typing (debounced)
        freqDisplay.addEventListener('input', (e) => {
            clearTimeout(freqInputTimeout);
            freqInputTimeout = setTimeout(() => {
                const freqMHz = parseFloat(e.target.value);
                if (!isNaN(freqMHz) && freqMHz >= 24 && freqMHz <= 1766) {
                    this.setFrequency(freqMHz);
                }
            }, 300); // Update after 300ms of no typing
        });

        freqDisplay.addEventListener('change', (e) => {
            clearTimeout(freqInputTimeout);
            const freqMHz = parseFloat(e.target.value);
            if (!isNaN(freqMHz)) {
                this.setFrequency(freqMHz);
            }
        });

        freqDisplay.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                clearTimeout(freqInputTimeout);
                e.target.blur();
                const freqMHz = parseFloat(e.target.value);
                if (!isNaN(freqMHz)) {
                    this.setFrequency(freqMHz);
                }
            }
        });

        // Select all text when clicking on frequency display
        freqDisplay.addEventListener('focus', (e) => {
            e.target.select();
        });

        // Frequency up/down buttons
        document.getElementById('freqUp').addEventListener('click', () => {
            this.adjustFrequency(this.frequencyStep);
        });

        document.getElementById('freqDown').addEventListener('click', () => {
            this.adjustFrequency(-this.frequencyStep);
        });

        // Frequency step buttons
        document.querySelectorAll('.freq-step-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.freq-step-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.frequencyStep = parseFloat(btn.dataset.step);
            });
        });


        // Sample rate
        document.getElementById('sampleRate').addEventListener('change', (e) => {
            const rate = parseInt(e.target.value);
            if (this.isConnected) {
                this.rtl.setSampleRate(rate);
                this.dsp.setSampleRate(rate);
            }
            this.updateFreqScale();
        });

        // Gain slider
        document.getElementById('gainSlider').addEventListener('input', (e) => {
            const gain = parseInt(e.target.value);
            document.getElementById('gainValue').textContent = gain === 0 ? 'Auto' : `${gain} dB`;
            if (this.isConnected) {
                this.rtl.setGain(gain);
            }
        });

        // Squelch slider
        document.getElementById('squelchSlider').addEventListener('input', (e) => {
            const squelch = parseInt(e.target.value);
            document.getElementById('squelchValue').textContent = squelch === 0 ? 'Off' : squelch;
            this.dsp.setSquelch(squelch);
        });

        // Filter slider
        document.getElementById('filterSlider').addEventListener('input', (e) => {
            const filter = parseInt(e.target.value);
            let bw;
            switch (this.currentMode) {
                case 'wfm': bw = 50000 + filter * 2000; break;
                case 'nfm': bw = 5000 + filter * 150; break;
                case 'am': bw = 3000 + filter * 140; break;
            }
            document.getElementById('filterValue').textContent = `${(bw / 1000).toFixed(1)} kHz`;
        });

        // Spectrum min slider
        document.getElementById('specMinSlider').addEventListener('input', (e) => {
            const min = parseInt(e.target.value);
            document.getElementById('specMinValue').textContent = `${min} dB`;
            if (this.visualizer) {
                const max = parseInt(document.getElementById('specMaxSlider').value);
                this.visualizer.setSpectrumRange(min, max);
            }
        });

        // Spectrum max slider
        document.getElementById('specMaxSlider').addEventListener('input', (e) => {
            const max = parseInt(e.target.value);
            document.getElementById('specMaxValue').textContent = `${max} dB`;
            if (this.visualizer) {
                const min = parseInt(document.getElementById('specMinSlider').value);
                this.visualizer.setSpectrumRange(min, max);
            }
        });

        // Volume slider
        document.getElementById('volumeSlider').addEventListener('input', (e) => {
            const volume = parseInt(e.target.value) / 100;
            this.audio.setVolume(volume);
        });

        // Mode buttons
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.currentMode = btn.dataset.mode;
                this.dsp.setMode(this.currentMode);

                // Update filter default
                const filterSlider = document.getElementById('filterSlider');
                filterSlider.value = 50;
                filterSlider.dispatchEvent(new Event('input'));
            });
        });

        // Setup canvas interactions (click, drag, touch) for all visualization canvases
        this.setupCanvasInteraction('spectrumCanvas');
        this.setupCanvasInteraction('waterfallCanvas');
        this.setupCanvasInteraction('waveformCanvas');

        // Keyboard shortcuts for frequency tuning
        document.addEventListener('keydown', (e) => {
            // Only if not in an input field
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                this.adjustFrequency(-this.frequencyStep);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                this.adjustFrequency(this.frequencyStep);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.adjustFrequency(this.frequencyStep * 10);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.adjustFrequency(-this.frequencyStep * 10);
            }
        });

        // Mouse wheel on canvases for frequency adjustment
        ['spectrumCanvas', 'waterfallCanvas', 'waveformCanvas'].forEach(canvasId => {
            document.getElementById(canvasId).addEventListener('wheel', (e) => {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -this.frequencyStep : this.frequencyStep;
                this.adjustFrequency(delta);
            }, { passive: false });
        });
    }

    // Setup click, drag, and touch interactions for a canvas
    setupCanvasInteraction(canvasId) {
        const canvas = document.getElementById(canvasId);
        let startX = 0;
        let startCenterFreq = 0;
        let hasMoved = false;
        let isMouseDown = false;

        // Mouse events
        canvas.addEventListener('mousedown', (e) => {
            isMouseDown = true;
            hasMoved = false;
            startX = e.clientX;
            startCenterFreq = this.centerFrequency;
            e.preventDefault();
        });

        const handleMouseMove = (e) => {
            if (!isMouseDown) return;

            const deltaX = e.clientX - startX;

            // Only consider it a drag after moving more than 3 pixels
            if (Math.abs(deltaX) > 3) {
                hasMoved = true;
                this.isDragging = true;

                const rect = canvas.getBoundingClientRect();
                const sampleRate = parseInt(document.getElementById('sampleRate').value);

                // Pan: dragging right = lower freq, dragging left = higher freq
                const freqShift = -(deltaX / rect.width) * sampleRate;
                const newCenterFreq = startCenterFreq + (freqShift / 1e6);

                this.setCenterFrequency(newCenterFreq, false);
            }
        };

        const handleMouseUp = (e) => {
            if (!isMouseDown) return;
            isMouseDown = false;

            if (hasMoved) {
                // Finished dragging - send final frequency
                const tunedFreq = this.centerFrequency + (this.tuneOffset / 1e6);
                if (this.isConnected) {
                    this.rtl.setFrequency(tunedFreq * 1e6);
                }
            } else {
                // It was a click, not a drag - tune to clicked position
                this.handleCanvasTune(e, canvas);
            }

            this.isDragging = false;
            hasMoved = false;
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);

        // Touch events
        canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                isMouseDown = true;
                hasMoved = false;
                startX = e.touches[0].clientX;
                startCenterFreq = this.centerFrequency;
            }
        }, { passive: true });

        canvas.addEventListener('touchmove', (e) => {
            if (!isMouseDown || e.touches.length !== 1) return;

            const deltaX = e.touches[0].clientX - startX;

            if (Math.abs(deltaX) > 3) {
                hasMoved = true;
                this.isDragging = true;
                e.preventDefault();

                const rect = canvas.getBoundingClientRect();
                const sampleRate = parseInt(document.getElementById('sampleRate').value);

                const freqShift = -(deltaX / rect.width) * sampleRate;
                const newCenterFreq = startCenterFreq + (freqShift / 1e6);

                this.setCenterFrequency(newCenterFreq, false);
            }
        }, { passive: false });

        canvas.addEventListener('touchend', (e) => {
            if (!isMouseDown) return;
            isMouseDown = false;

            if (hasMoved) {
                const tunedFreq = this.centerFrequency + (this.tuneOffset / 1e6);
                if (this.isConnected) {
                    this.rtl.setFrequency(tunedFreq * 1e6);
                }
            }
            // Note: touchend doesn't provide position, so no click-to-tune on touch

            this.isDragging = false;
            hasMoved = false;
        });
    }

    // Click tunes to that frequency - actually retunes the SDR
    handleCanvasTune(e, canvas) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const width = rect.width;

        // Calculate the frequency at the clicked position
        const sampleRate = parseInt(document.getElementById('sampleRate').value);
        const clickRatio = x / width; // 0 to 1 across the display
        const freqOffset = (clickRatio - 0.5) * sampleRate; // Offset from center in Hz
        const clickedFreqMHz = this.centerFrequency + (freqOffset / 1e6);

        // Retune to the clicked frequency (this becomes the new center)
        this.setFrequency(clickedFreqMHz);
    }

    // Update the visual position of all indicator lines
    updateIndicatorPosition() {
        const pos = `${this.indicatorPosition}%`;
        document.getElementById('spectrumIndicator').style.left = pos;
        document.getElementById('waterfallIndicator').style.left = pos;
        document.getElementById('waveformIndicator').style.left = pos;
    }

    // Set the center frequency of the display (for panning)
    setCenterFrequency(freqMHz, sendToRTL = true) {
        freqMHz = Math.max(24, Math.min(1766, freqMHz));
        const oldCenterFreq = this.centerFrequency;
        this.centerFrequency = freqMHz;

        // Update the frequency scale
        this.updateFreqScale();

        // The tuned frequency is center + offset
        const tunedFreq = this.centerFrequency + (this.tuneOffset / 1e6);

        // Update displays
        document.getElementById('frequencyDisplay').value = tunedFreq.toFixed(3);
        this.updateFrequencyDisplay(tunedFreq);

        // Clear waterfall when frequency changes significantly (more than 10% of bandwidth)
        const sampleRate = parseInt(document.getElementById('sampleRate').value);
        const freqChange = Math.abs(freqMHz - oldCenterFreq) * 1e6;
        if (freqChange > sampleRate * 0.1 && this.visualizer) {
            this.visualizer.clearWaterfall();
        }

        // Update visualizer with frequency info for grid lines
        if (this.visualizer) {
            this.visualizer.setFrequencyInfo(freqMHz * 1e6, sampleRate);
        }

        if (sendToRTL && this.isConnected) {
            this.rtl.setFrequency(tunedFreq * 1e6);
            this.lastRtlUpdateFreq = tunedFreq;
        } else if (!sendToRTL && this.isConnected) {
            // During dragging, send throttled updates (every 100ms)
            if (!this.rtlUpdateTimer) {
                this.rtlUpdateTimer = setTimeout(() => {
                    const currentTunedFreq = this.centerFrequency + (this.tuneOffset / 1e6);
                    this.rtl.setFrequency(currentTunedFreq * 1e6);
                    this.lastRtlUpdateFreq = currentTunedFreq;
                    if (this.visualizer) {
                        this.visualizer.clearWaterfall();
                    }
                    this.rtlUpdateTimer = null;
                }, 100);
            }
        }
    }

    // Set the tuned frequency (where the red line is)
    // This updates where the SDR is tuned but keeps the display centered on current view
    setTunedFrequency(freqMHz, sendToRTL = true) {
        freqMHz = Math.max(24, Math.min(1766, freqMHz));

        // Update displays
        document.getElementById('frequencyDisplay').value = freqMHz.toFixed(3);
        this.updateFrequencyDisplay(freqMHz);

        // Update visualizer with actual tuned frequency for correct spectrum display
        const sampleRate = parseInt(document.getElementById('sampleRate').value);
        if (this.visualizer) {
            this.visualizer.setFrequencyInfo(freqMHz * 1e6, sampleRate);
        }

        if (sendToRTL && this.isConnected) {
            this.rtl.setFrequency(freqMHz * 1e6);
            this.lastRtlUpdateFreq = freqMHz;
        }
    }

    // Set frequency - this sets both center and moves indicator to center
    setFrequency(freqMHz, sendToRTL = true) {
        // Clamp to valid range
        freqMHz = Math.max(24, Math.min(1766, freqMHz));

        // Set as center frequency with indicator at center
        this.centerFrequency = freqMHz;
        this.tuneOffset = 0;
        this.indicatorPosition = 50;
        this.updateIndicatorPosition();

        // Update the frequency display
        this.updateFrequencyDisplay(freqMHz);

        // Update frequency scale
        this.updateFreqScale();

        // Clear waterfall when frequency changes
        if (this.visualizer) {
            this.visualizer.clearWaterfall();
            // Update visualizer with frequency info for grid lines
            const sampleRate = parseInt(document.getElementById('sampleRate').value);
            this.visualizer.setFrequencyInfo(freqMHz * 1e6, sampleRate);
        }

        // Send to RTL-TCP if connected
        if (sendToRTL && this.isConnected) {
            console.log(`Tuning to ${freqMHz.toFixed(3)} MHz`);
            this.rtl.setFrequency(freqMHz * 1e6);
            this.lastRtlUpdateFreq = freqMHz;
        }
    }

    // Adjust frequency by delta - pans the view
    adjustFrequency(deltaMHz) {
        const newCenterFreq = this.centerFrequency + deltaMHz;
        this.setCenterFrequency(newCenterFreq);
    }

    // Update the large frequency display
    updateFrequencyDisplay(freqMHz) {
        const display = document.getElementById('frequencyDisplay');
        // Only update if not focused (to avoid disrupting user input)
        if (document.activeElement !== display) {
            display.value = freqMHz.toFixed(3);
        }
    }

    async connect() {
        const host = document.getElementById('wsHost').value;
        const port = document.getElementById('wsPort').value;
        const secure = document.getElementById('secureWs').checked;

        this.showLoading(true);

        try {
            await this.rtl.connect(host, port, secure);
            await this.audio.init();

            this.isConnected = true;
            this.updateConnectionUI(true);

            // Set initial parameters
            const freqMHz = parseFloat(document.getElementById('frequencyDisplay').value);
            const sampleRate = parseInt(document.getElementById('sampleRate').value);
            const gain = parseInt(document.getElementById('gainSlider').value);

            // Initialize frequency model
            this.centerFrequency = freqMHz;
            this.tuneOffset = 0;
            this.indicatorPosition = 50;

            this.rtl.setFrequency(freqMHz * 1e6);
            this.rtl.setSampleRate(sampleRate);
            this.rtl.setGain(gain);
            this.dsp.setSampleRate(sampleRate);

            // Update visualizer with frequency info for grid lines
            if (this.visualizer) {
                this.visualizer.setFrequencyInfo(freqMHz * 1e6, sampleRate);
                this.visualizer.clearWaterfall();
            }

            // Update displays
            this.updateFrequencyDisplay(freqMHz);
            this.updateIndicatorPosition();
            this.updateFreqScale();

            // Set up data handler
            this.rtl.onData = (data) => this.handleData(data);
            this.rtl.onDisconnect = () => this.handleDisconnect();

            this.showToast('Connected successfully');

        } catch (err) {
            console.error('Connection failed:', err);
            this.showToast('Connection failed: ' + err.message);
        }

        this.showLoading(false);
    }

    disconnect() {
        this.rtl.disconnect();
        this.audio.stop();
        this.isConnected = false;
        this.isPlaying = false;
        this.updateConnectionUI(false);
        this.showToast('Disconnected');
    }

    handleDisconnect() {
        this.isConnected = false;
        this.isPlaying = false;
        this.updateConnectionUI(false);
        this.showToast('Connection lost');
    }

    handleData(data) {
        // Accumulate data
        const newBuffer = new Uint8Array(this.dataBuffer.length + data.length);
        newBuffer.set(this.dataBuffer);
        newBuffer.set(data, this.dataBuffer.length);
        this.dataBuffer = newBuffer;

        // Process in chunks
        const chunkSize = 32768; // Process 16k IQ samples at a time

        while (this.dataBuffer.length >= chunkSize) {
            const chunk = this.dataBuffer.slice(0, chunkSize);
            this.dataBuffer = this.dataBuffer.slice(chunkSize);

            const result = this.dsp.process(chunk);

            // Update visualizations
            this.visualizer.drawWaterfall(result.iq);
            this.visualizer.drawWaveform(result.audio);

            // Play audio
            if (this.isPlaying) {
                this.audio.play(result.audio);
            }

            // Update stats
            this.updateStats(result.audio, result.iq);
        }
    }

    toggleAudio() {
        if (!this.isConnected) {
            this.showToast('Connect first');
            return;
        }

        this.isPlaying = !this.isPlaying;

        if (this.isPlaying) {
            this.audio.start();
            document.getElementById('playBtn').textContent = '⏸';
        } else {
            this.audio.stop();
            document.getElementById('playBtn').textContent = '▶';
        }
    }

    toggleRecording() {
        if (!this.isPlaying) {
            this.showToast('Start playback first to record');
            return;
        }

        this.isRecording = !this.isRecording;
        const recordBtn = document.getElementById('recordBtn');
        const recordingTime = document.getElementById('recordingTime');

        if (this.isRecording) {
            // Start recording
            this.audio.startRecording();
            recordBtn.classList.add('recording');
            recordBtn.textContent = '⏹';
            recordBtn.title = 'Stop recording';

            // Update recording time display
            this.recordingTimer = setInterval(() => {
                const duration = this.audio.getRecordingDuration();
                const mins = Math.floor(duration / 60);
                const secs = Math.floor(duration % 60);
                recordingTime.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
            }, 100);

            this.showToast('Recording started');
        } else {
            // Stop recording and export
            clearInterval(this.recordingTimer);
            this.recordingTimer = null;

            const filename = this.audio.stopRecording();
            recordBtn.classList.remove('recording');
            recordBtn.textContent = '⏺';
            recordBtn.title = 'Record audio';
            recordingTime.textContent = '';

            if (filename) {
                this.showToast(`Saved: ${filename}`);
            }
        }
    }

    updateStats(audio, iq) {
        // Buffer size
        document.getElementById('bufferStat').textContent =
            (this.dataBuffer.length / 1024).toFixed(1) + ' KB';

        // Sample rate
        const sampleRate = parseInt(document.getElementById('sampleRate').value);
        document.getElementById('rateStat').textContent =
            (sampleRate / 1000).toFixed(0) + ' kS/s';

        // Signal strength
        if (iq && iq.length > 0) {
            let sumSq = 0;
            for (let i = 0; i < Math.min(iq.length, 1000); i++) {
                sumSq += iq[i] * iq[i];
            }
            const rms = Math.sqrt(sumSq / Math.min(iq.length, 1000));
            const dB = 20 * Math.log10(Math.max(rms, 1e-10));
            document.getElementById('signalStat').textContent = dB.toFixed(1) + ' dB';
        }

        // Audio meter
        const rms = this.audio.getRMS(audio);
        const meterWidth = Math.min(100, rms * 500);
        document.getElementById('audioMeter').style.width = meterWidth + '%';
    }

    updateConnectionUI(connected) {
        const btn = document.getElementById('connectBtn');
        const dot = document.getElementById('statusDot');
        const text = document.getElementById('statusText');

        if (connected) {
            btn.textContent = 'Disconnect';
            btn.classList.add('btn-disconnect');
            dot.classList.add('connected');
            text.textContent = 'Connected';
        } else {
            btn.textContent = 'Connect';
            btn.classList.remove('btn-disconnect');
            dot.classList.remove('connected');
            text.textContent = 'Disconnected';
            document.getElementById('playBtn').textContent = '▶';
        }
    }

    updateFreqScale() {
        const scale = document.getElementById('freqScale');
        const centerFreq = this.centerFrequency; // Use the display center frequency
        const sampleRate = parseInt(document.getElementById('sampleRate').value);
        const halfBW = sampleRate / 2e6; // In MHz

        // Show 9 frequency labels for better granularity
        const step = halfBW / 4;
        scale.innerHTML = `
            <span>${(centerFreq - halfBW).toFixed(3)}</span>
            <span>${(centerFreq - halfBW + step).toFixed(3)}</span>
            <span>${(centerFreq - halfBW/2).toFixed(3)}</span>
            <span>${(centerFreq - step).toFixed(3)}</span>
            <span style="color: rgba(255,255,255,0.5);">${centerFreq.toFixed(3)}</span>
            <span>${(centerFreq + step).toFixed(3)}</span>
            <span>${(centerFreq + halfBW/2).toFixed(3)}</span>
            <span>${(centerFreq + halfBW - step).toFixed(3)}</span>
            <span>${(centerFreq + halfBW).toFixed(3)}</span>
        `;
    }

    showLoading(show) {
        document.getElementById('loadingOverlay').classList.toggle('active', show);
    }

    showToast(message) {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 3000);
    }

    // ========== Bookmark System ==========

    initBookmarks() {
        // Load bookmarks from cookies
        this.bookmarks = this.loadBookmarks();

        // Menu toggle
        document.getElementById('menuBtn').addEventListener('click', () => this.openMenu());
        document.getElementById('menuCloseBtn').addEventListener('click', () => this.closeMenu());
        document.getElementById('menuOverlay').addEventListener('click', () => this.closeMenu());

        // Add bookmark button
        document.getElementById('addBookmarkBtn').addEventListener('click', () => this.addCurrentBookmark());

        // Enter key in label input
        document.getElementById('bookmarkLabel').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.addCurrentBookmark();
        });

        // Preset buttons
        document.querySelectorAll('.preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const freq = parseFloat(btn.dataset.freq);
                const mode = btn.dataset.mode;
                this.tuneToBookmark(freq, mode);
                this.closeMenu();
            });
        });

        // Render bookmarks
        this.renderBookmarks();
    }

    openMenu() {
        document.getElementById('sideMenu').classList.add('active');
        document.getElementById('menuOverlay').classList.add('active');
    }

    closeMenu() {
        document.getElementById('sideMenu').classList.remove('active');
        document.getElementById('menuOverlay').classList.remove('active');
    }

    // Cookie utilities
    setCookie(name, value, days = 365) {
        const expires = new Date(Date.now() + days * 864e5).toUTCString();
        document.cookie = `${name}=${encodeURIComponent(JSON.stringify(value))}; expires=${expires}; path=/; SameSite=Strict`;
    }

    getCookie(name) {
        const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
        if (match) {
            try {
                return JSON.parse(decodeURIComponent(match[2]));
            } catch (e) {
                return null;
            }
        }
        return null;
    }

    loadBookmarks() {
        return this.getCookie('websdr_bookmarks') || [];
    }

    saveBookmarks() {
        this.setCookie('websdr_bookmarks', this.bookmarks);
    }

    addCurrentBookmark() {
        const labelInput = document.getElementById('bookmarkLabel');
        const label = labelInput.value.trim() || `${this.centerFrequency.toFixed(3)} MHz`;
        const freq = this.centerFrequency;
        const mode = this.dsp.mode;

        // Check for duplicate
        const exists = this.bookmarks.some(b => Math.abs(b.freq - freq) < 0.001);
        if (exists) {
            this.showToast('Frequency already bookmarked');
            return;
        }

        this.bookmarks.push({
            id: Date.now(),
            freq: freq,
            label: label,
            mode: mode
        });

        this.saveBookmarks();
        this.renderBookmarks();

        // Clear input
        labelInput.value = '';
        this.showToast(`Bookmarked ${freq.toFixed(3)} MHz`);
    }

    deleteBookmark(id) {
        this.bookmarks = this.bookmarks.filter(b => b.id !== id);
        this.saveBookmarks();
        this.renderBookmarks();
        this.showToast('Bookmark deleted');
    }

    tuneToBookmark(freq, mode) {
        // Set mode first
        if (mode && mode !== this.dsp.mode) {
            this.dsp.setMode(mode);
            document.querySelectorAll('.mode-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.mode === mode);
            });
        }

        // Tune to frequency
        this.setFrequency(freq);
    }

    renderBookmarks() {
        const list = document.getElementById('bookmarkList');

        if (this.bookmarks.length === 0) {
            list.innerHTML = '<div class="no-bookmarks">No bookmarks yet. Add your favorite frequencies!</div>';
            return;
        }

        // Sort by frequency
        const sorted = [...this.bookmarks].sort((a, b) => a.freq - b.freq);

        list.innerHTML = sorted.map(bookmark => `
            <div class="bookmark-item" data-id="${bookmark.id}" data-freq="${bookmark.freq}" data-mode="${bookmark.mode}">
                <span class="bookmark-freq">${bookmark.freq.toFixed(3)}</span>
                <span class="bookmark-label">${this.escapeHtml(bookmark.label)}</span>
                <span class="bookmark-mode">${bookmark.mode.toUpperCase()}</span>
                <button class="bookmark-delete" data-id="${bookmark.id}" title="Delete">×</button>
            </div>
        `).join('');

        // Add click handlers
        list.querySelectorAll('.bookmark-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.classList.contains('bookmark-delete')) return;
                const freq = parseFloat(item.dataset.freq);
                const mode = item.dataset.mode;
                this.tuneToBookmark(freq, mode);
                this.closeMenu();
            });
        });

        // Delete button handlers
        list.querySelectorAll('.bookmark-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = parseInt(btn.dataset.id);
                this.deleteBookmark(id);
            });
        });
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new WebSDRApp();
});
