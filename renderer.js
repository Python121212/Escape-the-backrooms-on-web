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
        this.computeBindGroup = null;

        // インスタンシング用
        this.maxDrawCount = 10000; 
        this.renderQueue = [];     
        this.indirectBuffer = null; 
        this.instanceBuffer = null; 

        // 3Dパイプライン用
        this.meshPipeline = null;
        this.fsrPipeline = null;

        // テスト用の時間カウント
        this.testTime = 0;
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
        // Canvasのフォーマットを取得（通常は rgba8unorm または bgra8unorm）
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
            // Compute Shaderから直接画面テクスチャに書き込むために STORAGE_BINDING を追加！！
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING,
            alphaMode: "opaque"
        });

        this.createGameTextures();
        this.initIndirectBuffers();

        // パイプラインの初期化（フォーマットを動的に合わせる）
        this.meshPipeline = await this.initMeshPipeline();
        this.fsrPipeline = await this.initFSRShader(canvasFormat);

        console.log(`[Renderer] 画面直結型グラフィックスエンジン初期化完了。`);
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
                let worldY = modelMatrix[3][1];
                let rotAngle = modelMatrix[0][0];
                
                let cosR = cos(rotAngle);
                let sinR = sin(rotAngle);
                let localPos = pos[vIdx % 6];
                let rotX = localPos.x * cosR - localPos.y * sinR;
                let rotY = localPos.x * sinR + localPos.y * cosR;

                var output: VertexOutput;
                output.position = vec4<f32>(worldX + rotX, worldY + rotY, 0.0, 1.0);
                
                let shade = 0.6 + 0.4 * sin(f32(iIdx) * 0.5);
                output.color = vec4<f32>(0.9 * shade, 0.8 * shade, 0.2 * shade, 1.0); 
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
        // テストモード中はWasm入力をスルー
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
        }
    }

    createGameTextures() {
        if (this.inputTexture) this.inputTexture.destroy();

        this.inputTexture = this.device.createTexture({
            size: [this.renderWidth, this.renderHeight, 1],
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
        });
        this.inputTextureView = this.inputTexture.createView();
    }

    async initFSRShader(canvasFormat) {
        // 💡 ブラウザのCanvasフォーマット（rgba8unorm または bgra8unorm）に動的にシェーダーを適応させる
        const fsrWGSL = `
            @group(0) @binding(0) var inputTex: texture_2d<f32>;
            @group(0) @binding(1) var outputTex: texture_storage_2d<${canvasFormat}, write>;

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
        if (!this.device || !this.meshPipeline || !this.fsrPipeline) return;

        try {
            this.testTime += 0.03;
            
            // 100個のオブジェクトを捏造生成
            const forcedDrawCount = 100;
            const indirectData = new Uint32Array([6, forcedDrawCount, 0, 0]);
            const instanceData = new Float32Array(forcedDrawCount * 16);

            let idx = 0;
            for (let x = -5; x < 5; x++) {
                for (let y = -5; y < 5; y++) {
                    const arrayOffset = idx * 16;
                    const posX = (x / 5.0) + 0.1;
                    const posY = (y / 5.0) + 0.1;
                    
                    instanceData[arrayOffset + 0] = this.testTime + idx; 
                    instanceData[arrayOffset + 12] = posX;               
                    instanceData[arrayOffset + 13] = posY;               
                    idx++;
                }
            }

            this.device.queue.writeBuffer(this.indirectBuffer, 0, indirectData);
            this.device.queue.writeBuffer(this.instanceBuffer, 0, instanceData);

            // 💡 毎フレーム最新のCanvasView（現在の画面テクスチャ）を取得
            const currentCanvasView = this.context.getCurrentTexture().createView();

            // 💡 現在の画面テクスチャを直接Computeのバインドグループに結合する！！
            const currentComputeBindGroup = this.device.createBindGroup({
                layout: this.fsrPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.inputTextureView },
                    { binding: 1, resource: currentCanvasView } // ➔ 画面テクスチャ直結
                ]
            });

            const meshBindGroup = this.device.createBindGroup({
                layout: this.meshPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: this.instanceBuffer } }
                ]
            });

            const commandEncoder = this.device.createCommandEncoder();
            
            // [STEP 1] 内部解像度テクスチャへ3D描画
            const renderPassDesc = {
                colorAttachments: [{
                    view: this.inputTextureView,
                    clearValue: { r: 0.1, g: 0.1, b: 0.08, a: 1.0 }, 
                    loadOp: "clear",
                    storeOp: "store"
                }]
            };
            const renderPass = commandEncoder.beginRenderPass(renderPassDesc);
            renderPass.setPipeline(this.meshPipeline);
            renderPass.setBindGroup(0, meshBindGroup);
            renderPass.drawIndirect(this.indirectBuffer, 0); 
            renderPass.end();

            // [STEP 2] Compute Shaderで画面へ直接書き込み！
            const computePass = commandEncoder.beginComputePass();
            computePass.setPipeline(this.fsrPipeline);
            computePass.setBindGroup(0, currentComputeBindGroup);
            computePass.dispatchWorkgroups(Math.ceil(this.displayWidth / 16), Math.ceil(this.displayHeight / 16));
            computePass.end();

            // コマンド転送
            this.device.queue.submit([commandEncoder.finish()]);

        } catch (err) {
            console.error("[Render Loop Error]:", err);
            this.device = null; 
        }
    }
}
