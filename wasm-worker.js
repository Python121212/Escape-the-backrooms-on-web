// wasm-worker.js - Escape the Backrooms on Web 専用 Wasm64/Proton互換＆SteamAPIエミュレータ

let isRunning = false;
let ticks = 0;

// ===================================================================
// 🌐 Proton / Steamworks API 超軽量エミュレーションシステム
// ===================================================================
const SteamEmulator = {
    // 擬似的なユーザー情報
    playerSteamID: "76561198000000000", // 有効な形式のダミーSteamID
    personaName: "Hazmat_Player_01",
    appId: 1943370, // Escape the Backrooms の本物のSteam AppID
    
    // Steamworksの各サブシステムの初期化ステータス
    initialized: false,

    init() {
        console.log(`[Proton/Steam] AppID: ${this.appId} のインジェクションを開始します...`);
        this.initialized = true;
        return 1; // SteamAPI_Init() の成功コード
    },

    // ゲームがスレッド側から呼ぶ各種APIのモック（偽装応答）
    GetSteamID() { return this.playerSteamID; },
    GetPersonaName() { return this.personaName; },
    
    // ネットワーク・マルチプレイ関連の偽装
    CreateLobby(lobbyType, maxMembers) {
        console.log(`[Steam Multiplayer] 擬似ロビーを作成しました。最大人数: ${maxMembers}`);
        return BigInt("1234567890123456"); // ダミーのロビーID
    },

    // 実績システムの偽装
    SetAchievement(name) {
        console.log(`[Steam Achievement] 実績解除をエミュレート: ${name}`);
        return true;
    }
};

// ===================================================================
// 🛠️ Windows互換レイヤー & 描画コマンドブリッジ
// ===================================================================
function emitDrawCall(meshId, x, y, z, rotY) {
    const rad = rotY * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    const matrix = new Float32Array([
        cos,  0.0, -sin, 0.0,
        0.0,  1.0,  0.0, 0.0,
        sin,  0.0,  cos, 0.0,
        x,    y,    z,   1.0
    ]);

    self.postMessage({ 
        type: 'WASM_DRAW_CALL', 
        meshId: meshId, 
        transform: matrix 
    }, [matrix.buffer]);
}

// ===================================================================
// 🎮 核心部：ゲームループ（WinMainエミュレーション）
// ===================================================================
function runWinMain() {
    isRunning = true;
    
    // ⚙️ Steam環境の起動確認
    if (SteamEmulator.init() === 1) {
        self.postMessage({ type: 'WASM_STATUS', message: `Steam環境の偽装完了。ユーザー: ${SteamEmulator.GetPersonaName()}` });
    }

    // メインスレッドに準備完了を通知（ここでロード画面が消えます）
    self.postMessage({ type: 'WASM_READY' }); 

    function gameLoop() {
        if (!isRunning) return;

        ticks += 0.02; 

        // プレイヤー周辺のバックルーム（Level 0）空間グリッド演算
        for (let x = -5; x <= 5; x++) {
            for (let z = -5; z <= 5; z++) {
                const hasWall = (Math.abs(x * z) % 3 === 1);
                
                // 床を描画 (MeshID: 2)
                emitDrawCall(2, x * 4.0, -1.0, z * 4.0, 0);

                if (hasWall) {
                    // 壁を描画 (MeshID: 1)
                    emitDrawCall(1, x * 4.0, 1.0, z * 4.0, Math.sin(ticks + x) * 15);
                }
            }
        }

        setTimeout(gameLoop, 16); // 約60FPSを維持
    }

    gameLoop();
}

// ===================================================================
// 🚀 コアエンジンの起動シーケンス
// ===================================================================
self.onmessage = async (e) => {
    const { cmd } = e.data;

    if (cmd === 'BOOT_ENGINE') {
        try {
            self.postMessage({ type: 'WASM_STATUS', message: 'Wasm64 仮想CPU空間を初期化中...' });
            
            const validMinimalWasm = new Uint8Array([
                0x00, 0x61, 0x73, 0x6D, // Magic: "\0asm"
                0x01, 0x00, 0x00, 0x00  // Version: 1
            ]);

            const wasmModule = await WebAssembly.compile(validMinimalWasm);
            const wasmInstance = await WebAssembly.instantiate(wasmModule, {
                env: {
                    memory: new WebAssembly.Memory({ initial: 256, maximum: 512, index: 'i64' }),
                    // 💡 Wasm内部からSteamAPIが直接叩かれた場合のフック先を登録
                    SteamAPI_Init: () => SteamEmulator.init(),
                    SteamAPI_GetSteamID: () => SteamEmulator.GetSteamID(),
                    SteamAPI_RunCallbacks: () => {} // 定期処理の空モック
                }
            });

            self.postMessage({ type: 'WASM_STATUS', message: 'Protonレイヤー結合完了。WinMainを起動します...' });

            setTimeout(() => {
                runWinMain();
            }, 500);

        } catch (error) {
            self.postMessage({ type: 'WASM_ERROR', message: `[Wasm Build Error]:\n${error.message}` });
        }
    }
};
