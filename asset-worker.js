// asset-worker.js
// メインスレッドを1ミリも止めない、超高速ファイル処理専用Worker

self.onmessage = async (e) => {
    const { cmd, url } = e.data;

    if (cmd === 'START_LOAD') {
        try {
            self.postMessage({ type: 'STATUS', message: 'OPFS 高速ストレージを確保中...' });

            // 1. OPFS（ブラウザ内の仮想超高速ファイルシステム）のルートを取得
            const root = await navigator.storage.getDirectory();
            
            // 2. バックルーム用のアセットファイルを生成/展開
            const fileHandle = await root.getFileHandle('level0.pak', { create: true });
            
            // 3. 最速の同期アクセスハンドル（SyncAccessHandle）を召喚（Worker内でのみ使用可能）
            // これがメモリ(Memory64)へのダイレクトマッピング（mmap）の土台になります
            const accessHandle = await fileHandle.createSyncAccessHandle();

            self.postMessage({ type: 'STATUS', message: 'Cloudflare R2 からアセットをストリーミング中...' });

            // 4. Cloudflare R2からデータをストリーミング取得
            const response = await fetch(url);
            if (!response.ok) throw new Error(`R2への接続に失敗: ${response.status}`);

            const reader = response.body.getReader();
            const contentLength = +response.headers.get('Content-Length') || 0;
            
            let receivedLength = 0;
            let fileOffset = 0;

            // チャンク（分割データ）が届くたびに、メモリを介して即座にディスクへ書き込む
            while(true) {
                const { done, value } = await reader.read();
                if (done) break;

                // ガベージコレクションを避けるため、Uint8Arrayの生バイナリのまま書き込み
                accessHandle.write(value, { at: fileOffset });
                fileOffset += value.byteLength;
                receivedLength += value.byteLength;

                if (contentLength > 0) {
                    const progress = Math.round((receivedLength / contentLength) * 100);
                    self.postMessage({ type: 'PROGRESS', progress: progress });
                }
            }

            // 5. 書き込み確定後、安全にクローズ
            accessHandle.flush();
            accessHandle.close();

            self.postMessage({ type: 'SUCCESS', message: 'ストレージマッピング完了' });

        } catch (error) {
            self.postMessage({ type: 'ERROR', message: error.message });
        }
    }
};
