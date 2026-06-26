// main.js - Escape the Backrooms on Web 統合メイン制御スクリプト

import { BackroomsRenderer } from './renderer.js';

const canvas = document.getElementById('gameCanvas');
const loadingOverlay = document.getElementById('loadingOverlay'); 
const statusText = document.getElementById('statusText');         

let renderer = null;
let wasmWorker = null;
let animationFrameId = null;
let isLoopStarted = false; // ループの二重起動防止フラグ

async function bootGame() {
    try {
        // 1. 描画層（WebGPU）の初期化
        if (statusText) statusText.innerText = "WebGPU グラフィックスエンジンを起動中...";
        renderer = new BackroomsRenderer(canvas);
        await renderer.init();

        // 2. 演算層（Wasm Worker）の生成
        if (statusText) statusText.innerText = "Wasm64 演算カーネルをロード中...";
        wasmWorker = new Worker('./wasm-worker.js');

        // 3. Wasmスレッドからのメッセージ受信イベントライン
        wasmWorker.onmessage = (e) => {
            const { type, message, meshId, transform } = e.data;

            switch (type) {
                case 'WASM_STATUS':
                    if (statusText) statusText.innerText = message;
                    break;

                case 'WASM_READY':
                    console.log("[Main] Wasmモジュールのアクティベート完了。");
                    // 🎮 準備完了シグナルが来たら、ここで確実に描画ループを起動
                    if (!isLoopStarted) {
                        startGameLoop();
                    }
                    // ロード画面をスムーズに消去
                    if (loadingOverlay) {
                        loadingOverlay.style.opacity = '0';
                        setTimeout(() => loadingOverlay.style.display = 'none', 300);
                    }
                    break;

                case 'WASM_DRAW_CALL':
                    // 📦 データが届いたらレンダラーのキューへ注入
                    if (renderer) {
                        renderer.pushMeshToRenderQueue(meshId, transform);
                    }
                    // 予備措置：最初のデータが届いた時点でループが未起動なら強制起動
                    if (!isLoopStarted) {
                        startGameLoop();
                        if (loadingOverlay) loadingOverlay.style.display = 'none';
                    }
                    break;

                case 'WASM_ERROR':
                    throw new Error(message);
            }
        };

        window.addEventListener('resize', () => {
            if (renderer) renderer.resize();
        });

        // 4. 演算カーネルへエンジン起動シグナルを発射
        wasmWorker.postMessage({ cmd: 'BOOT_ENGINE' });

    } catch (error) {
        console.error("[Fatal Main Error]:", error);
        showRuntimeError(error.message);
    }
}

// 🎮 画面更新と同期してレンダリングを回し続けるメインループ
function startGameLoop() {
    isLoopStarted = true;
    function loop() {
        if (renderer) {
            renderer.render();
        }
        animationFrameId = requestAnimationFrame(loop);
    }
    animationFrameId = requestAnimationFrame(loop);
}

function showRuntimeError(msg) {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    if (loadingOverlay) loadingOverlay.style.display = 'flex';
    if (statusText) {
        statusText.style.color = '#ff4444';
        statusText.innerText = msg;
    }
}

window.addEventListener('DOMContentLoaded', bootGame);
