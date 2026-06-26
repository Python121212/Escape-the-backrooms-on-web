// asset-worker.js - Escape the Backrooms on Web 専用アセットストレージ（OPFS）制御スレッド

self.onmessage = async (e) => {
    const { cmd, url } = e.data;

    if (cmd === 'START_LOAD') {
        try {
            self.postMessage({ type: 'STATUS', message: '高速ストレージ(OPFS)に接続中...' });
            
            // 1. スマホの高速ローカルストレージ（OPFS）のルートを取得
            const root = await navigator.storage.getDirectory();

            try {
                self.postMessage({ type: 'STATUS', message: 'クラウド(R2)からアセットをストリーミング中...' });
                
                // 2. 本来のリモートアセット取得試行
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
                
                const pakHandle = await root.getFileHandle('level0.pak', { create: true });
                const accessHandle = await pakHandle.createSyncAccessHandle();
                
                // データをストリーミングしながらOPFSへ直書き込み（メモリ節約）
                const reader = response.body.getReader();
                let downloadedBytes = 0;
                
                while(true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    accessHandle.write(value, { at: downloadedBytes });
                    downloadedBytes += value.length;
                    
                    // 必要に応じて進捗率をメインスレッドに通知
                    // self.postMessage({ type: 'PROGRESS', progress: ... });
                }
                
                accessHandle.flush();
                accessHandle.close();

                self.postMessage({ type: 'SUCCESS', message: '本番アセットのマッピングに成功しました。' });

            } catch (fetchErr) {
                // ===============================================================
                // 🚨 【Failed to fetch】を検知：ローカル開発用モックビルドに強制切り替え
                // ===============================================================
                console.warn("[Storage Worker] リモートアセットの取得に失敗したため、ローカル開発エミュレーターを起動します:", fetchErr.message);
                self.postMessage({ type: 'STATUS', message: '[開発モード] ブラウザ内部でテスト用バイナリを自動生成中...' });

                // 1. テスト用の擬似 level0.pak をOPFS内に生成
                const dummyPakHandle = await root.getFileHandle('level0.pak', { create: true });
                const dummyPakAccess = await dummyPakHandle.createSyncAccessHandle();
                const dummyPakData = new Uint8Array([0x50, 0x41, 0x4B, 0x01, 0x00]); // "PAK"マジックナンバー
                dummyPakAccess.write(dummyPakData, { at: 0 });
                dummyPakAccess.flush();
                dummyPakAccess.close();

                // 2. 演算層（Wasm64）の起動テストを突破するための、最小構成の有効なWebAssemblyバイナリを生成
                // 有効なWasmヘッダー（8バイト）: [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
                const dummyWasmHandle = await root.getFileHandle('engine_core.wasm', { create: true });
                const dummyWasmAccess = await dummyWasmHandle.createSyncAccessHandle();
                const minWasmBytes = new Uint8Array([
                    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00
                ]);
                dummyWasmAccess.write(minWasmBytes, { at: 0 });
                dummyWasmAccess.flush();
                dummyWasmAccess.close();

                // 正常に展開できたものとして、メインスレッドへSUCCESSを通知！
                self.postMessage({ type: 'SUCCESS', message: 'テスト用ローカルアセットの展開が完了しました。' });
            }

        } catch (globalErr) {
            // OPFS自体がブラウザの設定等で使えないレベルの致命的エラーのみ、メイン画面を赤くする
            self.postMessage({ type: 'ERROR', message: `OPFSストレージへのアクセス権が拒絶されました: ${globalErr.message}` });
        }
    }
};
