// main.js - Escape the Backrooms on Web 統合メイン制御スクリプト

import { BackroomsRenderer } from './renderer.js';

const canvas = document.getElementById('gameCanvas');
const loadingOverlay = document.getElementById('loadingOverlay'); // ロード画面の要素ID
const statusText = document.getElementById('statusText');         // テキスト表示用の要素ID

let renderer = null;
let wasmWorker = null;
let animationFrameId = null;

async function bootGame() {
    try {
        // 1. 描画層（WebGPU）の初期化
        if (statusText) statusText.innerText = "WebGPU グラフィックスエンジンを起動中...";
        renderer = new BackroomsRenderer(canvas);
        await renderer.init();

        // 2. 演算層（Wasm Worker）の生成と初期化
        if (statusText) statusText.innerText = "Wasm64 演算カーネルをロード中...";
        wasmWorker = new Worker('./wasm-worker.js');

        // 3. Wasmからのメッセージ転送・受信キャッチ網の構築
        wasmWorker.onmessage = (e) => {
            const { type, message, meshId, transform } = e.data;

            switch (type) {
                case 'WASM_STATUS':
                    // 進行状況のテキストを画面にフィードバック
                    if (statusText) statusText.innerText = `[Engine Core] ${message}`;
                    break;

                case 'WASM_READY':
                    // 🎮 演算層の準備が完了したら、ロード画面を即座に完全消去！
                    console.log("[Main] Wasmの準備完了を検知。ゲーム画面へ移行します。");
                    if (loadingOverlay) {
                        loadingOverlay.style.opacity = '0';
                        setTimeout(() => loadingOverlay.style.display = 'none', 300);
                    }
                    // メイン描画ループをここでキック！
                    startGameLoop();
                    break;

                case 'WASM_DRAW_CALL':
                    // 📦 Wasmから送られてきたポリゴン座標を描画キューにダイレクト注入
                    if (renderer) {
                        renderer.pushMeshToRenderQueue(meshId, transform);
                    }
                    break;

                case 'WASM_ERROR':
                    throw new Error(message);
            }
        };

        // 画面サイズ変更への追従
        window.addEventListener('resize', () => {
            if (renderer) renderer.resize();
        });

        // 4. 演算層へエンジン起動シグナル（WinMainキック）を発射！
        wasmWorker.postMessage({ cmd: 'BOOT_ENGINE' });

    } catch (error) {
        console.error("[Fatal Main Error]:", error);
        showRuntimeError(error.message);
    }
}

// 🎮 スマホの画面リフレッシュレート（60FPS〜120FPS）と同期する描画ループ
function startGameLoop() {
    function loop() {
        if (renderer) {
            // キューに溜まったバックルームのオブジェクトを画面にレンダリング
            renderer.render();
        }
        // 次のフレームの描画を予約
        animationFrameId = requestAnimationFrame(loop);
    }
    // ループ開始
    animationFrameId = requestAnimationFrame(loop);
}

// 致命的エラー時の画面表示用サブシステム
function showRuntimeError(msg) {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    if (loadingOverlay) loadingOverlay.style.display = 'flex';
    if (statusText) {
        statusText.style.color = '#ff4444';
        statusText.innerText = msg;
    }
}

// ブラウザの読み込み完了と同時にシステムを起動
window.addEventListener('DOMContentLoaded', bootGame);
