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

    connect(host, port) {
        return new Promise((resolve, reject) => {
            const wsUrl = `ws://${host}:${port}`;
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
        this.filterBandwidth = 15000;

        // Demodulation state
        this.lastI = 0;
        this.lastQ = 0;
        this.fmPhase = 0;

        // Audio state
        this.audioSampleRate = 48000;
        this.decimationFactor = Math.floor(sampleRate / this.audioSampleRate);

        // De-emphasis filter state (for FM)
        this.deemphState = 0;
        this.deemphAlpha = 1 - Math.exp(-1 / (this.audioSampleRate * 75e-6));

        // Low-pass filter coefficients
        this.lpfCoeffs = this.designLPF(this.filterBandwidth);
        this.lpfBuffer = new Float32Array(this.lpfCoeffs.length);
        this.lpfIndex = 0;

        // DC blocker
        this.dcBlockerState = 0;
        this.dcBlockerAlpha = 0.995;
    }

    setMode(mode) {
        this.mode = mode;
        switch (mode) {
            case 'wfm':
                this.filterBandwidth = 150000;
                this.decimationFactor = Math.floor(this.sampleRate / this.audioSampleRate);
                break;
            case 'nfm':
                this.filterBandwidth = 12500;
                this.decimationFactor = Math.floor(this.sampleRate / this.audioSampleRate);
                break;
            case 'am':
                this.filterBandwidth = 10000;
                this.decimationFactor = Math.floor(this.sampleRate / this.audioSampleRate);
                break;
        }
        this.lpfCoeffs = this.designLPF(this.filterBandwidth);
        this.lpfBuffer = new Float32Array(this.lpfCoeffs.length);
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
        const numTaps = 31;
        const coeffs = new Float32Array(numTaps);
        const fc = cutoff / this.sampleRate;
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

    applyLPF(sample) {
        this.lpfBuffer[this.lpfIndex] = sample;
        let output = 0;
        let idx = this.lpfIndex;

        for (let i = 0; i < this.lpfCoeffs.length; i++) {
            output += this.lpfBuffer[idx] * this.lpfCoeffs[i];
            idx--;
            if (idx < 0) idx = this.lpfCoeffs.length - 1;
        }

        this.lpfIndex = (this.lpfIndex + 1) % this.lpfCoeffs.length;
        return output;
    }

    dcBlocker(sample) {
        const output = sample - this.dcBlockerState + this.dcBlockerAlpha * this.dcBlockerState;
        this.dcBlockerState = sample;
        return output;
    }

    deemphasis(sample) {
        this.deemphState = this.deemphState + this.deemphAlpha * (sample - this.deemphState);
        return this.deemphState;
    }

    // Convert unsigned 8-bit IQ samples to float
    processIQ(data) {
        const numSamples = Math.floor(data.length / 2);
        const iq = new Float32Array(numSamples * 2);

        for (let i = 0; i < numSamples; i++) {
            iq[i * 2] = (data[i * 2] - 127.5) / 127.5;     // I
            iq[i * 2 + 1] = (data[i * 2 + 1] - 127.5) / 127.5; // Q
        }

        return iq;
    }

    // FM demodulation using arctangent differentiation
    demodulateFM(iq) {
        const numSamples = iq.length / 2;
        const audio = new Float32Array(Math.floor(numSamples / this.decimationFactor));
        let audioIdx = 0;

        for (let i = 0; i < numSamples; i++) {
            const currentI = iq[i * 2];
            const currentQ = iq[i * 2 + 1];

            // Quadrature demodulation
            const diffI = currentI * this.lastI + currentQ * this.lastQ;
            const diffQ = currentQ * this.lastI - currentI * this.lastQ;

            let demod = Math.atan2(diffQ, diffI);

            this.lastI = currentI;
            this.lastQ = currentQ;

            // Decimate
            if (i % this.decimationFactor === 0 && audioIdx < audio.length) {
                // Apply low-pass filter
                demod = this.applyLPF(demod);

                // Apply de-emphasis for broadcast FM
                if (this.mode === 'wfm') {
                    demod = this.deemphasis(demod);
                }

                // DC blocker
                demod = this.dcBlocker(demod);

                // Scale output
                audio[audioIdx++] = demod * 0.5;
            }
        }

        return audio;
    }

    // AM demodulation using envelope detection
    demodulateAM(iq) {
        const numSamples = iq.length / 2;
        const audio = new Float32Array(Math.floor(numSamples / this.decimationFactor));
        let audioIdx = 0;

        for (let i = 0; i < numSamples; i++) {
            const I = iq[i * 2];
            const Q = iq[i * 2 + 1];

            // Envelope detection
            let magnitude = Math.sqrt(I * I + Q * Q);

            // Decimate
            if (i % this.decimationFactor === 0 && audioIdx < audio.length) {
                // Apply low-pass filter
                magnitude = this.applyLPF(magnitude);

                // DC blocker
                magnitude = this.dcBlocker(magnitude);

                audio[audioIdx++] = magnitude;
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

        // Apply squelch
        if (this.squelch > 0) {
            const rms = Math.sqrt(audio.reduce((sum, s) => sum + s * s, 0) / audio.length);
            const threshold = this.squelch / 1000;
            if (rms < threshold) {
                audio.fill(0);
            }
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

        // Color palette for waterfall (blue to red to white)
        this.colorPalette = this.createColorPalette();

        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    createColorPalette() {
        const palette = new Array(256);
        for (let i = 0; i < 256; i++) {
            const ratio = i / 255;
            let r, g, b;

            if (ratio < 0.25) {
                // Black to blue
                const t = ratio / 0.25;
                r = 0;
                g = 0;
                b = Math.floor(t * 128);
            } else if (ratio < 0.5) {
                // Blue to cyan
                const t = (ratio - 0.25) / 0.25;
                r = 0;
                g = Math.floor(t * 255);
                b = 128 + Math.floor(t * 127);
            } else if (ratio < 0.75) {
                // Cyan to yellow
                const t = (ratio - 0.5) / 0.25;
                r = Math.floor(t * 255);
                g = 255;
                b = Math.floor((1 - t) * 255);
            } else {
                // Yellow to white
                const t = (ratio - 0.75) / 0.25;
                r = 255;
                g = 255;
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
    }

    drawWaterfall(iq) {
        if (!iq || iq.length < this.fftSize * 2) return;

        // Compute FFT magnitude
        const fftMag = this.computeFFT(iq);

        // Shift existing waterfall down
        if (this.waterfallData.length >= this.maxWaterfallLines) {
            this.waterfallData.shift();
        }
        this.waterfallData.push(fftMag);

        // Draw waterfall (color display only, no spectrum overlay)
        const ctx = this.waterfallCtx;
        const width = this.waterfallCanvas.width;
        const height = this.waterfallCanvas.height;

        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);

        const lineHeight = Math.max(1, height / this.maxWaterfallLines);

        for (let y = 0; y < this.waterfallData.length; y++) {
            const line = this.waterfallData[y];
            const pixelY = height - (y + 1) * lineHeight;

            for (let x = 0; x < width; x++) {
                const binIndex = Math.floor(x / width * line.length);
                const value = Math.min(255, Math.max(0, Math.floor(line[binIndex] * 2.5)));
                ctx.fillStyle = this.colorPalette[value];
                ctx.fillRect(x, pixelY, 1, lineHeight);
            }
        }

        // Draw spectrum on its own canvas
        this.drawSpectrum(fftMag);
    }

    drawSpectrum(fftMag) {
        const ctx = this.spectrumCtx;
        const width = this.spectrumCanvas.width;
        const height = this.spectrumCanvas.height;

        // Clear with dark background
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);

        // Draw horizontal grid lines
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
            const y = (height / 4) * i;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }

        // Draw spectrum line (white/cyan gradient)
        ctx.strokeStyle = 'rgba(100, 255, 218, 0.9)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();

        for (let x = 0; x < width; x++) {
            const binIndex = Math.floor(x / width * fftMag.length);
            const magnitude = fftMag[binIndex] / 100;
            const y = height - magnitude * height * 0.8;

            if (x === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }

        ctx.stroke();

        // Draw filled area under the spectrum
        ctx.lineTo(width, height);
        ctx.lineTo(0, height);
        ctx.closePath();
        ctx.fillStyle = 'rgba(100, 255, 218, 0.15)';
        ctx.fill();
    }

    computeFFT(iq) {
        const N = this.fftSize;
        const real = new Float32Array(N);
        const imag = new Float32Array(N);

        // Copy IQ data and apply window
        for (let i = 0; i < N && i * 2 + 1 < iq.length; i++) {
            const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); // Hanning
            real[i] = iq[i * 2] * window;
            imag[i] = iq[i * 2 + 1] * window;
        }

        // Cooley-Tukey FFT
        this.fft(real, imag);

        // Compute magnitude in dB
        const magnitude = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            // Rearrange for center DC
            const idx = (i + N / 2) % N;
            const mag = Math.sqrt(real[idx] * real[idx] + imag[idx] * imag[idx]);
            magnitude[i] = 20 * Math.log10(Math.max(mag, 1e-10)) + 100; // Offset to positive
        }

        return magnitude;
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
        const initialFreq = parseFloat(document.getElementById('frequency').value);
        this.centerFrequency = initialFreq;
        this.tuneOffset = 0;
        this.indicatorPosition = 50;

        // Update displays
        this.updateFrequencyDisplay(initialFreq);
        this.updateIndicatorPosition();
        this.updateFreqScale();
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

        // Frequency input (direct entry)
        document.getElementById('frequency').addEventListener('change', (e) => {
            const freqMHz = parseFloat(e.target.value);
            if (!isNaN(freqMHz)) {
                this.setFrequency(freqMHz);
            }
        });

        // Frequency Go button
        document.getElementById('freqGoBtn').addEventListener('click', () => {
            const freqMHz = parseFloat(document.getElementById('frequency').value);
            if (!isNaN(freqMHz)) {
                this.setFrequency(freqMHz);
            }
        });

        // Enter key on frequency input
        document.getElementById('frequency').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const freqMHz = parseFloat(e.target.value);
                if (!isNaN(freqMHz)) {
                    this.setFrequency(freqMHz);
                }
            }
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

        // Click on frequency display to focus input
        document.getElementById('frequencyDisplay').addEventListener('click', () => {
            document.getElementById('frequency').focus();
            document.getElementById('frequency').select();
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

        // Click to tune (for quick taps)
        canvas.addEventListener('click', (e) => {
            if (this.isDragging) return; // Ignore clicks during drag
            this.handleCanvasTune(e, canvas);
        });

        // Mouse drag for scrolling frequency
        canvas.addEventListener('mousedown', (e) => {
            this.startDrag(e, canvas);
        });

        document.addEventListener('mousemove', (e) => {
            if (this.isDragging && this.dragCanvas === canvas) {
                this.handleDrag(e, canvas);
            }
        });

        document.addEventListener('mouseup', () => {
            this.endDrag();
        });

        // Touch support for mobile
        canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                this.startDrag(e.touches[0], canvas);
            }
        }, { passive: true });

        canvas.addEventListener('touchmove', (e) => {
            if (this.isDragging && e.touches.length === 1) {
                e.preventDefault();
                this.handleDrag(e.touches[0], canvas);
            }
        }, { passive: false });

        canvas.addEventListener('touchend', () => {
            this.endDrag();
        });
    }

    // SDR++ style: Click moves the indicator to that position
    handleCanvasTune(e, canvas) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const width = rect.width;

        // Move the indicator to the clicked position
        this.indicatorPosition = (x / width) * 100;
        this.updateIndicatorPosition();

        // Calculate the actual frequency at this position
        const sampleRate = parseInt(document.getElementById('sampleRate').value);
        this.tuneOffset = (this.indicatorPosition / 100 - 0.5) * sampleRate;

        // Calculate and set the tuned frequency
        const tunedFreq = this.centerFrequency + (this.tuneOffset / 1e6);
        this.setTunedFrequency(tunedFreq);
    }

    startDrag(e, canvas) {
        this.isDragging = false; // Will be set to true after movement threshold
        this.dragCanvas = canvas;
        this.dragStartX = e.clientX;
        this.dragStartCenterFreq = this.centerFrequency;
        this.dragMoved = 0;
    }

    // SDR++ style: Drag pans the entire view (changes center frequency)
    handleDrag(e, canvas) {
        const deltaX = e.clientX - this.dragStartX;
        this.dragMoved += Math.abs(deltaX - (this.lastDeltaX || 0));
        this.lastDeltaX = deltaX;

        // Only consider it a drag after moving more than 5 pixels
        if (this.dragMoved > 5) {
            this.isDragging = true;
        }

        if (this.isDragging) {
            const rect = canvas.getBoundingClientRect();
            const sampleRate = parseInt(document.getElementById('sampleRate').value);

            // Pan the view: dragging right shows lower frequencies, left shows higher
            const freqShift = -(deltaX / rect.width) * sampleRate;
            const newCenterFreq = this.dragStartCenterFreq + (freqShift / 1e6);

            this.setCenterFrequency(newCenterFreq, false); // Don't send to RTL during drag
        }
    }

    endDrag() {
        if (this.isDragging) {
            // Send final tuned frequency to RTL when drag ends
            const tunedFreq = this.centerFrequency + (this.tuneOffset / 1e6);
            if (this.isConnected) {
                this.rtl.setFrequency(tunedFreq * 1e6);
            }
        }
        this.isDragging = false;
        this.dragCanvas = null;
        this.dragMoved = 0;
        this.lastDeltaX = 0;
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
        this.centerFrequency = freqMHz;

        // Update the frequency scale
        this.updateFreqScale();

        // The tuned frequency is center + offset
        const tunedFreq = this.centerFrequency + (this.tuneOffset / 1e6);

        // Update displays
        document.getElementById('frequency').value = tunedFreq.toFixed(3);
        this.updateFrequencyDisplay(tunedFreq);

        if (sendToRTL && this.isConnected) {
            this.rtl.setFrequency(tunedFreq * 1e6);
        }
    }

    // Set the tuned frequency (where the red line is)
    setTunedFrequency(freqMHz, sendToRTL = true) {
        freqMHz = Math.max(24, Math.min(1766, freqMHz));

        // Update displays
        document.getElementById('frequency').value = freqMHz.toFixed(3);
        this.updateFrequencyDisplay(freqMHz);

        if (sendToRTL && this.isConnected) {
            this.rtl.setFrequency(freqMHz * 1e6);
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

        // Update input field
        document.getElementById('frequency').value = freqMHz.toFixed(3);

        // Update large display
        this.updateFrequencyDisplay(freqMHz);

        // Update frequency scale
        this.updateFreqScale();

        // Send to RTL-TCP if connected
        if (sendToRTL && this.isConnected) {
            this.rtl.setFrequency(freqMHz * 1e6);
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
        display.innerHTML = `${freqMHz.toFixed(3)}<span class="frequency-unit">MHz</span>`;
    }

    async connect() {
        const host = document.getElementById('wsHost').value;
        const port = document.getElementById('wsPort').value;

        this.showLoading(true);

        try {
            await this.rtl.connect(host, port);
            await this.audio.init();

            this.isConnected = true;
            this.updateConnectionUI(true);

            // Set initial parameters
            const freqMHz = parseFloat(document.getElementById('frequency').value);
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
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new WebSDRApp();
});
