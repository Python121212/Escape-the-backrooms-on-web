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

        // MDI (Multi-Draw Indirect) 用のバッファ・キュー設計
        this.maxDrawCount = 10000; 
        this.renderQueue = [];     
        this.indirectBuffer = null; 
        this.instanceBuffer = null; 
    }

    // 1. WebGPUの初期化（順序バグを完全修正）
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
        
        // 【修正ポイント1】まずは画面サイズとテクスチャのベースを確保（バインドグループ更新はまだしない）
        this.displayWidth = Math.floor(window.innerWidth * window.devicePixelRatio);
        this.displayHeight = Math.floor(window.innerHeight * window.devicePixelRatio);
        this.renderWidth = Math.floor(this.displayWidth * this.scaleFactor);
        this.renderHeight = Math.floor(this.displayHeight * this.scaleFactor);

        this.canvas.width = this.displayWidth;
        this.canvas.height = this.displayHeight;

        this.context.configure({
            device: this.device,
            format: canvasFormat,
            alphaMode: "opaque"
        });

        // 内部テクスチャメモリの初期確保
        this.createGameTextures();

        // MDI用バッファの生成
        this.initIndirectBuffers();

        // 【修正ポイント2】先にFSRパイプラインをビルドして実体を確定させる
        this.fsrPipeline = await this.initFSRShader();
        
        // 【修正ポイント3】パイプラインが確定した後に安全にバインド
        this.updateBindGroups();

        console.log(`[Renderer] MDI & FSR 1.0 パイプライン完全覚醒。`);
    }

    // MDI用のGPU専用バッファをVRAM上に確保
    initIndirectBuffers() {
        this.indirectBuffer = this.device.createBuffer({
            size: this.maxDrawCount * 5 * 4, 
            usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
            mappedAtCreation: false
        });

        this.instanceBuffer = this.device.createBuffer({
            size: this.maxDrawCount * 16 * 4, 
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            mappedAtCreation: false
        });
    }

    // 演算層から描画命令を詰め込む窓口
    pushMeshToRenderQueue(meshId, transformMatrixArray) {
        if (this.renderQueue.length >= this.maxDrawCount) return;
        
        this.renderQueue.push({
            meshId: meshId,
            transform: transformMatrixArray 
        });
    }

    // 動的リサイズハンドラ
    resize() {
        this.displayWidth = Math.floor(window.innerWidth * window.devicePixelRatio);
        this.displayHeight = Math.floor(window.innerHeight * window.devicePixelRatio);
        
        this.renderWidth = Math.floor(this.displayWidth * this.scaleFactor);
        this.renderHeight = Math.floor(this.displayHeight * this.scaleFactor);

        if (this.renderWidth <= 0 || this.renderHeight <= 0) return;

        this.canvas.width = this.displayWidth;
        this.canvas.height = this.displayHeight;

        if (this.device && this.fsrPipeline) {
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
        if (!this.device || !this.inputTextureView || !this.outputTextureView || !this.fsrPipeline) return;

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

            if (drawCount > 0) {
                const indirectData = new Uint32Array(drawCount * 5);
                const instanceData = new Float32Array(drawCount * 16);

                for (let i = 0; i < drawCount; i++) {
                    const obj = this.renderQueue[i];
                    const idx = i * 5;
                    indirectData[idx + 0] = 36; 
                    indirectData[idx + 1] = 1;  
                    indirectData[idx + 2] = 0;  
                    indirectData[idx + 3] = 0;  
                    indirectData[idx + 4] = i;  

                    instanceData.set(obj.transform, i * 16);
                }

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
            this.renderQueue = [];

        } catch (err) {
            console.error("[Render Loop Error]:", err);
            window.dispatchEvent(new CustomEvent('game-error', { detail: `描画ループ内エラー: ${err.message}` }));
            this.device = null; 
        }
    }
}
