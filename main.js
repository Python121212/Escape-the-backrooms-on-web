// main.js - Escape the Backrooms on Web 統合メイン制御スクリプト

import { BackroomsRenderer } from './renderer.js';

const canvas = document.getElementById('gameCanvas');
const loadingOverlay = document.getElementById('loadingOverlay'); 
const statusText = document.getElementById('statusText');         

let renderer = null;
let wasmWorker = null;
let animationFrameId = null;

async function bootGame() {
    try {
        // 1. 描画層（WebGPU）の初期化
        if (statusText) statusText.innerText = "WebGPU グラフィックスエンジンを起動中...";
        renderer = new BackroomsRenderer(canvas);
        await renderer.init();

        // 2. 演算層（Wasm Worker）の生成
        if (statusText) statusText.innerText = "Wasm64 演算カーネルをロード中...";
        wasmWorker = new Worker('./wasm-worker.js');

        // 3. Wasmスレッドからのメッセージ受信イベントラインの確立
        wasmWorker.onmessage = (e) => {
            const { type, message, meshId, transform } = e.data;

            switch (type) {
                case 'WASM_STATUS':
                    // コンパイルの進行状況などをロード画面にリアルタイム反映
                    if (statusText) statusText.innerText = message;
                    break;

                case 'WASM_READY':
                    // 🎮 正規のWasmコンパイルを無事通過！ロード画面を消去してゲームへ
                    console.log("[Main] Wasmモジュールが正規にアクティベートされました。");
                    if (loadingOverlay) {
                        loadingOverlay.style.opacity = '0';
                        setTimeout(() => loadingOverlay.style.display = 'none', 300);
                    }
                    // 高速描画ループ（毎フレーム実行）をここでキック！
                    startGameLoop();
                    break;

                case 'WASM_DRAW_CALL':
                    // 📦 Wasmから送られてきたバックルームの壁・床の位置行列をレンダラーのキューへ流し込む
                    if (renderer) {
                        renderer.pushMeshToRenderQueue(meshId, transform);
                    }
                    break;

                case 'WASM_ERROR':
                    // コンパイルエラーなどが発生した場合は即座に画面に表示
                    throw new Error(message);
            }
        };

        // 画面リサイズへの完全追従
        window.addEventListener('resize', () => {
            if (renderer) renderer.resize();
        });

        // 4. 演算カーネルへ「エンジン起動（BOOT_ENGINE）」のパルスを発射
        wasmWorker.postMessage({ cmd: 'BOOT_ENGINE' });

    } catch (error) {
        console.error("[Fatal Main Error]:", error);
        showRuntimeError(error.message);
    }
}

// 🎮 スマホのリフレッシュレート（60FPS〜120FPS）と同期して画面を書き換えるメインループ
function startGameLoop() {
    function loop() {
        if (renderer) {
            // renderer.js 内の描画コマンドを実行し、バッファをクリアする
            renderer.render();
        }
        // 次のフレームを描画予約
        animationFrameId = requestAnimationFrame(loop);
    }
    // ループの開始
    animationFrameId = requestAnimationFrame(loop);
}

// エラー発生時の緊急表示用サブシステム
function showRuntimeError(msg) {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    if (loadingOverlay) loadingOverlay.style.display = 'flex';
    if (statusText) {
        statusText.style.color = '#ff4444';
        statusText.innerText = msg;
    }
}

// ページ読み込み完了時にシステムを起動
window.addEventListener('DOMContentLoaded', bootGame);
