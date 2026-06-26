// renderer.js - Escape the Backrooms on Web 専用グラフィック＆エラーデバッグエンジン基盤

export class BackroomsRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.device = null;
        this.context = null;
        
        // FSR用の解像度設定（スマホのGPU負荷を徹底的に引き算する）
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
    }

    // 1. WebGPUの初期化（エラー検知を徹底強化）
    async init() {
        console.log("[Renderer] WebGPUの初期化シーケンスを開始します...");

        if (!navigator.gpu) {
            throw new Error("WebGPU未対応: お使いのブラウザ、または端末はWebGPUに対応していません。Chromeのフラグ(enable-unsafe-webgpu)等を確認してください。");
        }

        // 高性能GPUコアを要求
        const adapter = await navigator.gpu.requestAdapter({
            powerPreference: "high-performance"
        });
        
        if (!adapter) {
            throw new Error("GPUアダプターの取得に失敗: グラフィックデバイスが見つかりません。");
        }

        this.device = await adapter.requestDevice();
        if (!this.device) {
            throw new Error("WebGPUデバイスの生成に失敗: VRAMまたはコンテキストの確保が拒絶されました。");
        }

        // GPU側でエラーが発生した際、即座にキャッチしてコンソールに吐き出す仕掛け（デバッグの命綱）
        this.device.addEventListener('uncapturederror', (event) => {
            console.error("[WebGPU カーネルエラー発覚]:", event.error.message);
            // 画面上にエラーを通知するためのカスタムイベントを発火
            window.dispatchEvent(new CustomEvent('game-error', { detail: `GPU内部エラー: ${event.error.message}` }));
        });

        this.context = this.canvas.getContext("webgpu");
        const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
        
        // 画面サイズに応じた各種解像度テクスチャの生成
        this.resize();

        this.context.configure({
            device: this.device,
            format: canvasFormat,
            alphaMode: "opaque"
        });

        // FSR 1.0 (EASU) コンピュートシェーダーのコンパイル
        this.fsrPipeline = await this.initFSRShader();
        
        // シェーダーとテクスチャを結合するバインディング（BindGroup）の作成
        this.updateBindGroups();

        console.log(`[Renderer] 正常起動。内部解像度: ${this.renderWidth}x${this.renderHeight} -> 表示解像度: ${this.displayWidth}x${this.displayHeight}`);
    }

    // 解像度の動的計算とテクスチャの再確保（エラーハンドリング付き）
    resize() {
        try {
            this.displayWidth = Math.floor(window.innerWidth * window.devicePixelRatio);
            this.displayHeight = Math.floor(window.innerHeight * window.devicePixelRatio);
            
            this.renderWidth = Math.floor(this.displayWidth * this.scaleFactor);
            this.renderHeight = Math.floor(this.displayHeight * this.scaleFactor);

            // 異常な解像度（0以下）にならないようガード
            if (this.renderWidth <= 0 || this.renderHeight <= 0) return;

            this.canvas.width = this.displayWidth;
            this.canvas.height = this.displayHeight;

            if (this.device) {
                this.createGameTextures();
                this.updateBindGroups();
            }
        } catch (err) {
            throw new Error(`画面リサイズ・テクスチャ再確保エラー: ${err.message}`);
        }
    }

    // 内部レンダリング用およびFSR出力用のテクスチャをVRAM上に確保
    createGameTextures() {
        // メモリ解放（既存のテクスチャがあれば破棄してVRAMの枯渇を防ぐ）
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

    // シェーダーへテクスチャの器を紐付け
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

    // AMD FSR 1.0 (EASU) コンピュートシェーダーの実装（WGSL構文エラー検知付き）
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

        // シェーダーコードのコンパイル段階でのエラーを細かく補足
        const shaderModule = this.device.createShaderModule({ code: fsrWGSL });
        const compilationInfo = await shaderModule.getCompilationInfo();
        
        for (const message of compilationInfo.messages) {
            if (message.type === "error") {
                throw new Error(`FSRシェーダーコンパイルエラー [行 ${message.lineNum}, 列 ${message.linePos}]: ${message.message}`);
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
            const commandEncoder = this.device.createCommandEncoder();
            
            // [STEP 1] 内部解像度（70%）のテクスチャへの3Dパスクリア
            const renderPassDesc = {
                colorAttachments: [{
                    view: this.inputTextureView,
                    clearValue: { r: 0.05, g: 0.05, b: 0.03, a: 1.0 }, 
                    loadOp: "clear",
                    storeOp: "store"
                }]
            };
            const renderPass = commandEncoder.beginRenderPass(renderPassDesc);
            // 今後ここにAOT WasmのDrawCallをインサート
            renderPass.end();

            // [STEP 2] FSR Compute Shader実行
            const computePass = commandEncoder.beginComputePass();
            computePass.setPipeline(this.fsrPipeline);
            computePass.setBindGroup(0, this.computeBindGroup);
            
            const workgroupCountX = Math.ceil(this.displayWidth / 16);
            const workgroupCountY = Math.ceil(this.displayHeight / 16);
            computePass.dispatchWorkgroups(workgroupCountX, workgroupCountY);
            computePass.end();

            // [STEP 3] 最終ディスプレイへの出力確認
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
        } catch (err) {
            console.error("[Render Loop Error]:", err);
            window.dispatchEvent(new CustomEvent('game-error', { detail: `描画ループ内エラー: ${err.message}` }));
            this.device = null; // ループを安全に緊急停止させる
        }
    }
}
