// Bundle beside index.html and the named clips. Uses the production XR player.
import { VRPlayer } from '../extension/src/vr-player.js';
import { PlaybackDiagnostics } from '../extension/src/playback-diagnostics.js';
import * as THREE from 'three';

const video = document.querySelector('video');
let player, diagnostics;
let failures = [];
let visibilityChanges = [];
let xrFrameCount = 0;
let visibleFrameCount = 0;
let lastReceiptTime = null, lastPredictedTime = null;
let receiptIntervals = [], predictedIntervals = [];
let nonAdvancingPredictedTimestamps = 0;

function resetCallbackTiming() {
    lastReceiptTime = lastPredictedTime = null;
    receiptIntervals = [];
    predictedIntervals = [];
}

function intervalSummary(intervals) {
    const sorted = [...intervals].sort((a, b) => a - b);
    return { intervals: intervals.length,
        fps: intervals.length ? 1000 * intervals.length / intervals.reduce((a, b) => a + b, 0) : null,
        p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null };
}

globalThis.decodeProbe = {
    async start(codec) {
        const files = { h264: 'h264-4k.mp4', 'h264-high': 'h264-high-4k.mp4', vp9: 'vp9-4k.webm', av1: 'av1-4k.mp4', vp8: 'vp8-360.webm' };
        video.src = files[codec];
        video.muted = true;
        video.loop = true;
        await video.play();
        await new Promise(resolve => video.requestVideoFrameCallback(resolve));
        diagnostics = new PlaybackDiagnostics(video);
        return { width: video.videoWidth, height: video.videoHeight, xrSupported: await navigator.xr.isSessionSupported('immersive-vr'), visibility: null };
    },
    async enterXR() {
        resetCallbackTiming();
        nonAdvancingPredictedTimestamps = 0;
        player = new VRPlayer(video, 'FLAT', { diagnostics, onFailure: message => failures.push(message) });
        document.body.append(player.canvas);
        const render = player.renderFrame;
        player.renderFrame = time => {
            xrFrameCount++;
            if (player.session?.visibilityState === 'visible') {
                visibleFrameCount++;
                const receipt = performance.now();
                if (lastReceiptTime !== null && receipt > lastReceiptTime) receiptIntervals.push(receipt - lastReceiptTime);
                if (lastPredictedTime !== null) {
                    if (time > lastPredictedTime) predictedIntervals.push(time - lastPredictedTime);
                    else nonAdvancingPredictedTimestamps++;
                }
                if (receiptIntervals.length > 180) receiptIntervals.shift();
                if (predictedIntervals.length > 180) predictedIntervals.shift();
                lastReceiptTime = receipt;
                lastPredictedTime = time;
            } else resetCallbackTiming();
            render(time);
        };
        const session = await player.enterVR();
        visibilityChanges.push({ time: performance.now(), state: session.visibilityState });
        session.addEventListener('visibilitychange', () => {
            resetCallbackTiming();
            visibilityChanges.push({ time: performance.now(), state: session.visibilityState });
        });
        return { visibility: session.visibilityState, frameRate: session.frameRate ?? null,
            supportedFrameRates: session.supportedFrameRates ? [...session.supportedFrameRates] : null };
    },
    snapshot() {
        return { stats: diagnostics.snapshot(), time: video.currentTime, documentVisibility: document.visibilityState,
            xrVisibility: player?.session?.visibilityState ?? null, xrFrameRate: player?.session?.frameRate ?? null,
            xrFrameCount, visibleFrameCount, visibilityChanges, failures,
            xrCallbackTiming: { receipt: intervalSummary(receiptIntervals), predicted: intervalSummary(predictedIntervals),
                nonAdvancingPredictedTimestamps,
                scope: 'Recent 180 visible intervals per series; predicted uses advancing timestamps only; not compositor or reprojection timing' } };
    },
    beginMeasurement() {
        const before = this.snapshot();
        diagnostics.reset();
        xrFrameCount = visibleFrameCount = 0;
        nonAdvancingPredictedTimestamps = 0;
        resetCallbackTiming();
        return before;
    },
    async checkTexture() {
        // Exercise the same VideoTexture import as XR, with readable pixels.
        const wasPaused = video.paused;
        video.pause();
        const width = 256, height = 144;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(video, 0, 0, width, height);
        const reference = context.getImageData(0, 0, width, height).data;
        const renderer = new THREE.WebGLRenderer({ antialias: false });
        const target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: false });
        target.texture.colorSpace = THREE.SRGBColorSpace;
        const texture = new THREE.VideoTexture(video);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        const material = new THREE.MeshBasicMaterial({ map: texture });
        const geometry = new THREE.PlaneGeometry(2, 2);
        try {
            const scene = new THREE.Scene();
            scene.add(new THREE.Mesh(geometry, material));
            const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
            camera.position.z = 1;
            renderer.setRenderTarget(target);
            renderer.render(scene, camera);
            const pixels = new Uint8Array(width * height * 4);
            renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
            let absoluteError = 0, maxError = 0, rgbSum = 0;
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const cpu = (y * width + x) * 4;
                    const gpu = ((height - y - 1) * width + x) * 4;
                    for (let channel = 0; channel < 3; channel++) {
                        const error = Math.abs(reference[cpu + channel] - pixels[gpu + channel]);
                        absoluteError += error;
                        maxError = Math.max(maxError, error);
                        rgbSum += pixels[gpu + channel];
                    }
                }
            }
            return { width, height, meanAbsoluteRGBError: absoluteError / (width * height * 3),
                maxRGBError: maxError, meanRGBValue: rgbSum / (width * height * 3),
                canvasReadable: true, scope: 'Real WebGL VideoTexture readback compared to Canvas2D; not a headset-view screenshot' };
        } finally {
            geometry.dispose();
            material.dispose();
            texture.dispose();
            target.dispose();
            renderer.dispose();
            renderer.forceContextLoss();
            if (!wasPaused) await video.play();
        }
    },
    async stop() {
        if (!diagnostics) return null;
        video.pause();
        const before = { time: video.currentTime, paused: video.paused, volume: video.volume };
        if (player) {
            await player.dispose();
            player.canvas.remove();
            player = null;
        }
        return { before, after: { time: video.currentTime, paused: video.paused, volume: video.volume }, canvasRemoved: !document.querySelector('canvas') };
    },
};
