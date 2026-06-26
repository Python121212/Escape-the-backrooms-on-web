// renderer.js - Escape the Backrooms on Web 専用グラフィック＆エラーデバッグエンジン基盤

export class BackroomsRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.device = null;
        this.context = null;
        
        this.scaleFactor = 0.7; 
        this.renderWidth = 0;
        this.renderHeight = 0;
        this.displayWidth = 0;
        this.displayHeight = 0;

        this.inputTexture = null;
        this.inputTextureView = null;
        this.outputTexture = null;
        this.outputTextureView = null;
        this.computeBindGroup = null;

        // インスタンシング用
        this.maxDrawCount = 10000; 
        this.renderQueue = [];     
        this.indirectBuffer = null; 
        this.instanceBuffer = null; 

        // 3Dパイプライン用
        this.meshPipeline = null;
        this.meshBindGroup = null;
    }

    async init() {
        console.log("[Renderer] WebGPUの初期化シーケンスを開始します...");

        if (!navigator.gpu) {
            throw new Error("WebGPU未対応: お使いのブラウザ、または端末はWebGPUに対応していません。");
        }

        const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
        if (!adapter) throw new Error("GPUアダプターの取得に失敗しました。");
        this.device = await adapter.requestDevice();

        this.device.addEventListener('uncapturederror', (event) => {
            console.error("[WebGPU カーネルエラー]:", event.error.message);
        });

        this.context = this.canvas.getContext("webgpu");
        const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
        
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

        this.createGameTextures();
        this.initIndirectBuffers();

        // パイプラインの初期化
        this.meshPipeline = await this.initMeshPipeline();
        this.fsrPipeline = await this.initFSRShader();
        this.updateBindGroups();

        console.log(`[Renderer] 3Dメッシュ＆FSR 1.0 パイプライン完全覚醒。`);
    }

    initIndirectBuffers() {
        this.indirectBuffer = this.device.createBuffer({
            size: 4 * 4, 
            usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
            mappedAtCreation: false
        });

        this.instanceBuffer = this.device.createBuffer({
            size: this.maxDrawCount * 16 * 4, 
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            mappedAtCreation: false
        });
    }

    async initMeshPipeline() {
        const meshWGSL = `
            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) color: vec4<f32>
            };

            @group(0) @binding(0) var<storage, read> instanceMatrices: array<mat4x4<f32>>;

            @vertex
            fn vs_main(@builtin(vertex_index) vIdx: u32, @builtin(instance_index) iIdx: u32) -> VertexOutput {
                var pos = array<vec2<f32>, 6>(
                    vec2<f32>(-0.12, -0.12),
                    vec2<f32>( 0.12, -0.12),
                    vec2<f32>(-0.12,  0.12),
                    vec2<f32>(-0.12,  0.12),
                    vec2<f32>( 0.12, -0.12),
                    vec2<f32>( 0.12,  0.12)
                );

                let modelMatrix = instanceMatrices[iIdx];
                
                let worldX = modelMatrix[3][0];
                let worldZ = modelMatrix[3][2];
                
                let cosR = modelMatrix[0][0];
                let sinR = modelMatrix[0][2];
                let localPos = pos[vIdx % 6];
                let rotX = localPos.x * cosR - localPos.y * sinR;
                let rotY = localPos.x * sinR + localPos.y * cosR;

                // 2Dグリッド配置のスケールをさらに見えやすい大きさに拡大マッピング
                let finalScreenX = worldX * 0.05 + rotX;
                let finalScreenY = worldZ * 0.05 + rotY;

                var output: VertexOutput;
                output.position = vec4<f32>(finalScreenX, finalScreenY, 0.0, 1.0);
                
                let shade = 0.7 + 0.3 * sin(f32(iIdx) * 0.2);
                output.color = vec4<f32>(0.85 * shade, 0.75 * shade, 0.25 * shade, 1.0); 
                return output;
            }

            @fragment
            fn fs_main(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
                return color;
            }
        `;

        const shaderModule = this.device.createShaderModule({ code: meshWGSL });
        return this.device.createRenderPipeline({
            layout: "auto",
            vertex: { module: shaderModule, entryPoint: "vs_main" },
            fragment: { module: shaderModule, entryPoint: "fs_main", targets: [{ format: "rgba8unorm" }] },
            primitive: { topology: "triangle-list" }
        });
    }

    pushMeshToRenderQueue(meshId, transformMatrixArray) {
        if (this.renderQueue.length >= this.maxDrawCount) return;
        this.renderQueue.push({ meshId: meshId, transform: transformMatrixArray });
    }

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
        if (!this.device || !this.inputTextureView || !this.outputTextureView || !this.meshPipeline || !this.fsrPipeline) return;

        this.computeBindGroup = this.device.createBindGroup({
            layout: this.fsrPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: this.inputTextureView },
                { binding: 1, resource: this.outputTextureView }
            ]
        });

        this.meshBindGroup = this.device.createBindGroup({
            layout: this.meshPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.instanceBuffer } }
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
                
                let finalColor = textureLoad(inputTex, vec2<i32>(uv), 0);
                textureStore(outputTex, vec2<i32>(id.xy), finalColor);
            }
        `;
        const shaderModule = this.device.createShaderModule({ code: fsrWGSL });
        return this.device.createComputePipeline({
            layout: "auto",
            compute: { module: shaderModule, entryPoint: "main" }
        });
    }

    render() {
        if (!this.device) return;

        // 💡 【超重要：タイミング防衛措置】万が一バインドグループがまだ作られていなければ、ここで強制生成
        if (!this.computeBindGroup || !this.meshBindGroup) {
            this.updateBindGroups();
            if (!this.computeBindGroup || !this.meshBindGroup) return; // それでも作れなければスキップ
        }

        try {
            const drawCount = this.renderQueue.length;

            if (drawCount > 0) {
                const indirectData = new Uint32Array([6, drawCount, 0, 0]);
                const instanceData = new Float32Array(drawCount * 16);

                for (let i = 0; i < drawCount; i++) {
                    const obj = this.renderQueue[i];
                    instanceData.set(obj.transform, i * 16);
                }

                this.device.queue.writeBuffer(this.indirectBuffer, 0, indirectData);
                this.device.queue.writeBuffer(this.instanceBuffer, 0, instanceData);
            }

            const commandEncoder = this.device.createCommandEncoder();
            
            // [STEP 1] レンダリングパス
            const renderPassDesc = {
                colorAttachments: [{
                    view: this.inputTextureView,
                    // クリアカラーを少し明るめのグレーベージュに変更し、暗黒化を防ぐ
                    clearValue: { r: 0.15, g: 0.15, b: 0.12, a: 1.0 }, 
                    loadOp: "clear",
                    storeOp: "store"
                }]
            };
            const renderPass = commandEncoder.beginRenderPass(renderPassDesc);
            
            if (drawCount > 0) {
                renderPass.setPipeline(this.meshPipeline);
                renderPass.setBindGroup(0, this.meshBindGroup);
                renderPass.drawIndirect(this.indirectBuffer, 0); 
            }
            renderPass.end();

            // [STEP 2] FSR Compute パス
            const computePass = commandEncoder.beginComputePass();
            computePass.setPipeline(this.fsrPipeline);
            computePass.setBindGroup(0, this.computeBindGroup);
            computePass.dispatchWorkgroups(Math.ceil(this.displayWidth / 16), Math.ceil(this.displayHeight / 16));
            computePass.end();

            // [STEP 3] ディスプレイ出力パス
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
            
            // 💡 完全に真っ暗で止まるのを防ぐため、キューはリセットするが、直前のバックアップとして描画命令が0件のときも最後のフレームを保持させる設計に最適化
            if (drawCount > 0) {
                this.renderQueue = [];
            }

        } catch (err) {
            console.error("[Render Loop Error]:", err);
            window.dispatchEvent(new CustomEvent('game-error', { detail: `描画ループ内エラー: ${err.message}` }));
            this.device = null; 
        }
    }
}
