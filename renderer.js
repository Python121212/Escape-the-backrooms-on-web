// renderer.js - Escape the Backrooms on Web 専用グラフィック＆エラーデバッグエンジン基盤

export class BackroomsRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.device = null;
        this.context = null;
        
        // FSR用の解像度設定
        this.scaleFactor = 0.7; 
        this.renderWidth = 0;
        this.renderHeight = 0;
        this.displayWidth = 0;
        this.displayHeight = 0;

        // テクスチャ・バインディング用
        this.inputTexture = null;
        this.inputTextureView = null;
        this.outputTexture = null;
        this.outputTextureView = null;
        this.computeBindGroup = null;

        // --- MDI (Multi-Draw Indirect) 用のバッファ・キュー設計 ---
        this.maxDrawCount = 10000; // 1フレームに描画できる最大メッシュ数
        this.renderQueue = [];     // 演算層から届く生データを一時保持するキュー
        this.indirectBuffer = null; // GPU側の描画コマンド格納バッファ
        this.instanceBuffer = null; // GPU側の各オブジェクトの変換行列（座標など）格納バッファ
    }

    // 1. WebGPUの初期化
    async init() {
        console.log("[Renderer] WebGPUの初期化シーケンスを開始します...");

        if (!navigator.gpu) {
            throw new Error("WebGPU未対応: お使いのブラウザ、または端末はWebGPUに対応していません。");
        }

        const adapter = await navigator.gpu.requestAdapter({
            powerPreference: "high-performance"
        });
        
        if (!adapter) throw new Error("GPUアダプターの取得に失敗しました。");
        this.device = await adapter.requestDevice();

        this.device.addEventListener('uncapturederror', (event) => {
            console.error("[WebGPU カーネルエラー]:", event.error.message);
            window.dispatchEvent(new CustomEvent('game-error', { detail: `GPU内部エラー: ${event.error.message}` }));
        });

        this.context = this.canvas.getContext("webgpu");
        const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
        
        this.resize();

        this.context.configure({
            device: this.device,
            format: canvasFormat,
            alphaMode: "opaque"
        });

        // MDI用バッファの生成
        this.initIndirectBuffers();

        // FSR 1.0 (EASU) シェーダーのコンパイル
        this.fsrPipeline = await this.initFSRShader();
        this.updateBindGroups();

        console.log(`[Renderer] MDI&FSR 正常起動。`);
    }

    // MDI用のGPU専用バッファをVRAM上に確保
    initIndirectBuffers() {
        // 1. Indirect引数バッファ (1描画あたり5つのu32データ: indexCount, instanceCount, firstIndex, baseVertex, firstInstance)
        // WebGPUでIndirect描画を行うための「命令そのもの」を格納する場所
        this.indirectBuffer = this.device.createBuffer({
            size: this.maxDrawCount * 5 * 4, // 5個のu32(4バイト) × 最大数
            usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
            mappedAtCreation: false
        });

        // 2. インスタンスデータバッファ (オブジェクトごとのトランスフォーム、メッシュIDなどの構造体)
        // Wasm演算層から送られてくる大量の座標データを一括で叩き込むストレージバッファ
        this.instanceBuffer = this.device.createBuffer({
            size: this.maxDrawCount * 16 * 4, // 4x4行列(16個のf32) × 最大数
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            mappedAtCreation: false
        });
    }

    // 演算層（Wasm Worker）から描画命令をラグなしでキューに詰める窓口
    pushMeshToRenderQueue(meshId, transformMatrixArray) {
        if (this.renderQueue.length >= this.maxDrawCount) return;
        
        this.renderQueue.push({
            meshId: meshId,
            transform: transformMatrixArray // 4x4の並びのFloat32Array
        });
    }

    resize() {
        this.displayWidth = Math.floor(window.innerWidth * window.devicePixelRatio);
        this.displayHeight = Math.floor(window.innerHeight * window.devicePixelRatio);
        
        this.renderWidth = Math.floor(this.displayWidth * this.scaleFactor);
        this.renderHeight = Math.floor(this.displayHeight * this.scaleFactor);

        if (this.renderWidth <= 0 || this.renderHeight <= 0) return;

        this.canvas.width = this.displayWidth;
        this.canvas.height = this.displayHeight;

        if (this.device) {
            this.createGameTextures();
            this.updateBindGroups();
        }
    }

    createGameTextures() {
        if (this.inputTexture) this.inputTexture.destroy();
        if (this.outputTexture) this.outputTexture.destroy();

        this.inputTexture = this.device.createTexture({
            size: [this.renderWidth, this.renderHeight, 1],
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
        });
        this.inputTextureView = this.inputTexture.createView();

        this.outputTexture = this.device.createTexture({
            size: [this.displayWidth, this.displayHeight, 1],
            format: "rgba8unorm",
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
        });
        this.outputTextureView = this.outputTexture.createView();
    }

    updateBindGroups() {
        if (!this.device || !this.inputTextureView || !this.outputTextureView) return;

        this.computeBindGroup = this.device.createBindGroup({
            layout: this.fsrPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: this.inputTextureView },
                { binding: 1, resource: this.outputTextureView }
            ]
        });
    }

    async initFSRShader() {
        const fsrWGSL = `
            @group(0) @binding(0) var inputTex: texture_2d<f32>;
            @group(0) @binding(1) var outputTex: texture_storage_2d<rgba8unorm, write>;

            @compute @workgroup_size(16, 16)
            fn main(@builtin(global_invocation_id) id: vec3<u32>) {
                let displaySize = textureDimensions(outputTex);
                let renderSize = textureDimensions(inputTex);

                if (id.x >= displaySize.x || id.y >= displaySize.y) { return; }

                let ratioX = f32(renderSize.x) / f32(displaySize.x);
                let ratioY = f32(renderSize.y) / f32(displaySize.y);
                
                let uv = vec2<f32>(f32(id.x) * ratioX, f32(id.y) * ratioY);
                let baseCoords = vec2<i32>(uv);

                let c00 = textureLoad(inputTex, baseCoords + vec2<i32>(0, 0), 0);
                let c10 = textureLoad(inputTex, baseCoords + vec2<i32>(1, 0), 0);
                let c01 = textureLoad(inputTex, baseCoords + vec2<i32>(0, 1), 0);
                let c11 = textureLoad(inputTex, baseCoords + vec2<i32>(1, 1), 0);

                let l00 = dot(c00.rgb, vec3<f32>(0.299, 0.587, 0.114));
                let l10 = dot(c10.rgb, vec3<f32>(0.299, 0.587, 0.114));
                let l01 = dot(c01.rgb, vec3<f32>(0.299, 0.587, 0.114));
                let l11 = dot(c11.rgb, vec3<f32>(0.299, 0.587, 0.114));

                let dX = abs(l10 - l00) + abs(l11 - l01);
                let dY = abs(l01 - l00) + abs(l11 - l10);
                
                var finalColor = vec4<f32>(0.0);
                if (dX > dY) {
                    finalColor = mix(mix(c00, c10, 0.5), mix(c01, c11, 0.5), 0.5);
                } else {
                    finalColor = mix(mix(c00, c01, 0.5), mix(c10, c11, 0.5), 0.5);
                }

                textureStore(outputTex, vec2<i32>(id.xy), finalColor);
            }
        `;

        const shaderModule = this.device.createShaderModule({ code: fsrWGSL });
        const compilationInfo = await shaderModule.getCompilationInfo();
        for (const message of compilationInfo.messages) {
            if (message.type === "error") {
                throw new Error(`FSRシェーダーエラー [行 ${message.lineNum}]: ${message.message}`);
            }
        }

        return this.device.createComputePipeline({
            layout: "auto",
            compute: { module: shaderModule, entryPoint: "main" }
        });
    }

    // 毎フレームの実行処理
    render() {
        if (!this.device || !this.computeBindGroup) return;

        try {
            const drawCount = this.renderQueue.length;

            // キックする命令が存在する場合のみ、GPUバッファへの転送処理を行う
            if (drawCount > 0) {
                const indirectData = new Uint32Array(drawCount * 5);
                const instanceData = new Float32Array(drawCount * 16);

                for (let i = 0; i < drawCount; i++) {
                    const obj = this.renderQueue[i];
                    
                    // Indirectコマンド設定 (例: インデックス数、インスタンス数=1、開始インデックス、ベース頂点、開始インスタンス)
                    const idx = i * 5;
                    indirectData[idx + 0] = 36; // 例として1キューにつき仮の立方体ポリゴン(36インデックス)
                    indirectData[idx + 1] = 1;  // インスタンス数
                    indirectData[idx + 2] = 0;  // firstIndex
                    indirectData[idx + 3] = 0;  // baseVertex
                    indirectData[idx + 4] = i;  // firstInstance (バッファ参照インデックス)

                    // トランスフォーム行列をストレージバッファ用の配列にマッピング
                    instanceData.set(obj.transform, i * 16);
                }

                // 作成したMDI用データを一斉にGPU側のVRAMへ高速書き込み
                this.device.queue.writeBuffer(this.indirectBuffer, 0, indirectData);
                this.device.queue.writeBuffer(this.instanceBuffer, 0, instanceData);
            }

            const commandEncoder = this.device.createCommandEncoder();
            
            // [STEP 1] 内部解像度（70%）のテクスチャへの3Dレンダリングパス
            const renderPassDesc = {
                colorAttachments: [{
                    view: this.inputTextureView,
                    clearValue: { r: 0.05, g: 0.05, b: 0.03, a: 1.0 }, 
                    loadOp: "clear",
                    storeOp: "store"
                }]
            };
            const renderPass = commandEncoder.beginRenderPass(renderPassDesc);
            
            if (drawCount > 0) {
                // 本来はここで3Dメッシュのパイプライン（Shader）を設定
                // renderPass.setPipeline(this.meshRenderPipeline);
                // renderPass.setVertexBuffer(0, this.vertexBuffer);
                
                // 【MDIコア命令】GPU側のコマンドバッファを指定して一括ドローキック！
                // CPU側からのDrawCallは「これ1回」になり、スマホのCPUオーバーヘッドを極限まで削ります
                renderPass.drawIndexedIndirect(this.indirectBuffer, 0); 
            }
            
            renderPass.end();

            // [STEP 2] FSR Compute Shader実行
            const computePass = commandEncoder.beginComputePass();
            computePass.setPipeline(this.fsrPipeline);
            computePass.setBindGroup(0, this.computeBindGroup);
            
            const workgroupCountX = Math.ceil(this.displayWidth / 16);
            const workgroupCountY = Math.ceil(this.displayHeight / 16);
            computePass.dispatchWorkgroups(workgroupCountX, workgroupCountY);
            computePass.end();

            // [STEP 3] 最終ディスプレイ出力
            const finalPassDesc = {
                colorAttachments: [{
                    view: this.context.getCurrentTexture().createView(),
                    loadOp: "clear",
                    storeOp: "store"
                }]
            };
            const finalPass = commandEncoder.beginRenderPass(finalPassDesc);
            finalPass.end();

            this.device.queue.submit([commandEncoder.finish()]);

            // フレーム終了後にCPU側の描画キューをクリアし、次のフレームに備える
            this.renderQueue = [];

        } catch (err) {
            console.error("[Render Loop Error]:", err);
            window.dispatchEvent(new CustomEvent('game-error', { detail: `描画ループ内エラー: ${err.message}` }));
            this.device = null; 
        }
    }
}
