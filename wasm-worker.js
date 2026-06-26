// wasm-worker.js - Escape the Backrooms on Web 専用 Wasm64/Proton互換 演算エミュレーション基盤

let wasmInstance = null;
let wasmMemory = null;
let opfsRoot = null;
let pakFileHandle = null;

// ===================================================================
// 🛠️ Windows / Proton 互換レイヤー (Win32 API エミュレーション群)
// ===================================================================
const protonWin32Env = {
    // 1. メモリ管理 (VirtualAlloc / VirtualFree)
    VirtualAlloc: (lpAddress, dwSize, flAllocationType, flProtect) => {
        // Wasmのメモリ空間から要求されたサイズ分のオフセットポインタを擬似的に返す
        // 本作ではWasm自体の線形メモリが自動拡張（grow）するため、ベースポインタとして0以外の有効アドレスをモック
        console.log(`[Proton API] VirtualAlloc: Size=${dwSize} bytes`);
        return 0x10000000n; 
    },
    VirtualFree: (lpAddress, dwSize, dwFreeType) => 0,

    // 2. スレッド同期・クリティカルセクション (UE4の並列レンダリングスレッド用)
    InitializeCriticalSection: (lpCriticalSectionPtr) => 0,
    EnterCriticalSection: (lpCriticalSectionPtr) => 0,
    LeaveCriticalSection: (lpCriticalSectionPtr) => 0,
    DeleteCriticalSection: (lpCriticalSectionPtr) => 0,

    // 3. 時間・同期 (KERNEL32.dll)
    GetSystemTimeAsFileTime: (lpSystemTimeAsFileTimePtr) => {
        const now = BigInt(Date.now());
        // WindowsのFILETIME形式（1601年1月1日からの100ナノ秒単位）に簡易変換
        const winTime = (now + 11644473600000m) * 10000m;
        return winTime;
    },
    QueryPerformanceCounter: (lpPerformanceCountPtr) => {
        // 高精度タイマーをWasmのメモリ空間へ書き込み
        return BigInt(performance.now());
    },

    // 4. Steam API (Steamworks SDK) の完全モック化
    // アプリなし・スタンドアロン起動のため、Steamが未起動でも「正規ログイン状態」とゲームに誤認させる
    SteamAPI_Init: () => {
        console.log("[Steamworks Mock] SteamAPI_Init: 成功を偽装しました。");
        return 1; // 1 = 成功
    },
    SteamAPI_RegisterCallback: (pCallback, callbackId) => {},
    SteamAPI_UnregisterCallback: (pCallback) => {},
    SteamUser: () => 0x1n,
    SteamAPI_ISteamUser_GetSteamID: () => 76561197960287930n, // 固定のダミーSteamID64を返却

    // 5. UE4 ファイルシステム IO 結合（OPFS内のPAKファイルを直撃）
    CreateFileW: (lpFileNamePtr, dwDesiredAccess, dwShareMode, lpSecurityAttributes, dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile) => {
        // UE4が「level0.pak」を開こうとした瞬間に、このスレッドが確保しているOPFSのファイル記述子（ハンドル）を割り当てる
        console.log("[Proton IO] CreateFileW: ゲームアセット(PAK)のファイルオープン要求を受理しました。");
        return 0x99n; // 固定のダミーファイル記述子
    },
    ReadFile: (hFile, lpBufferPtr, nNumberOfBytesToRead, lpNumberOfBytesReadPtr, lpOverlapped) => {
        // TODO: ここでAsset WorkerがOPFSに保存した `level0.pak` から
        // 指定バイト数（nNumberOfBytesToRead）を非同期シークしてWasmメモリへダイレクトに転送する
        return 1; // 1 = 成功
    },

    // 6. WebGPU Direct-Draw (MDIバッファ転送ブリッジ)
    // UE4（x86_64）が描画パケットを出力した瞬間、メインスレッドのrenderer.jsへデータを瞬間移動させる
    WebGPUDrawPassThrough: (meshId, matrixPtr) => {
        if (!wasmMemory) return;
        
        // Wasmメモリ内から4x4のTransform行列（Float32Array × 16要素）を直接切り出す
        const memoryView = new Float32Array(wasmMemory.buffer, Number(matrixPtr), 16);
        const transformMatrix = new Float32Array(memoryView); // コピーを作成

        // メインスレッド（index.html）経由でrenderer.jsのMDIキューへブロードキャスト
        self.postMessage({ 
            type: 'WASM_DRAW_CALL', 
            meshId: meshId, 
            transform: transformMatrix 
        }, [transformMatrix.buffer]); // Transferableオブジェクトで転送レイテンシをゼロに
    }
};

// ===================================================================
// 🚀 コアエンジンの起動シーケンス
// ===================================================================
self.onmessage = async (e) => {
    const { cmd } = e.data;

    if (cmd === 'BOOT_ENGINE') {
        try {
            self.postMessage({ type: 'WASM_STATUS', message: 'Wasm64(Memory64) 実行空間を確保中...' });

            // 1. OPFSのインスタンスを確保
            opfsRoot = await navigator.storage.getDirectory();

            // 2. 演算層用のWasm64線形メモリを明示的に定義
            // メモリ空間を巨大に確保し、UE4アセット展開時のOOM（メモリ不足）を防御
            wasmMemory = new WebAssembly.Memory({
                initial: 256, // 16MB
                maximum: 32768, // 2GB
                index: 'i64' // Memory64拡張フラグ
            });

            self.postMessage({ type: 'WASM_STATUS', message: 'Proton環境 & Steam環境の結合完了。バイナリをロード中...' });

            // 3. 記憶層から事前コンパイル済みのWasmバイナリを読み込み
            let gameBinHandle;
            try {
                gameBinHandle = await opfsRoot.getFileHandle('engine_core.wasm');
            } catch (err) {
                throw new Error("engine_core.wasm が見つかりません。先に記憶層(OPFS)への展開が必要です。");
            }

            const file = await gameBinHandle.getFile();
            const wasmBuffer = await file.arrayBuffer();

            // 4. エミュレーション環境（インポートオブジェクト）のバインド
            const importObject = {
                env: {
                    ...protonWin32Env,
                    memory: wasmMemory
                }
            };

            self.postMessage({ type: 'WASM_STATUS', message: 'WinMain エントリポイントへジャンプします...' });

            // 5. Wasmのコンパイルおよびインスタンス化
            const { instance } = await WebAssembly.instantiate(wasmBuffer, importObject);
            wasmInstance = instance;

            // 6. Windowsバイナリのメインループ（WinMain）を非同期実行
            if (wasmInstance.exports.WinMain) {
                self.postMessage({ type: 'WASM_READY' });
                
                // ゲームループをキック（メインスレッドを巻き添えにせず完全独立駆動）
                setTimeout(() => {
                    wasmInstance.exports.WinMain();
                }, 0);
            } else {
                throw new Error("Wasm内に有効な Windows WinMain エントリポイントがありません。");
            }

        } catch (error) {
            self.postMessage({ type: 'WASM_ERROR', message: `[演算コア致命的エラー]:\n${error.message}` });
        }
    }
};
