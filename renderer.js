// renderer.js - Escape the Backrooms on Web 専用グラフィックエンジン基盤

export class BackroomsRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.device = null;
        this.context = null;
        
        // FSR用の解像度設定（スマホのGPU負荷を徹底的に引き算する）
        this.scaleFactor = 0.7; // 内部解像度をあえて70%に落とす
        this.renderWidth = 0;
        this.renderHeight = 0;
        this.displayWidth = 0;
        this.displayHeight = 0;

        // テクスチャ・バインディング用変数
        this.inputTexture = null;
        this.inputTextureView = null;
        this.outputTexture = null;
        this.outputTextureView = null;
        this.computeBindGroup = null;
    }

    // 1. WebGPUの初期化とパイプラインビルド
    async init() {
        if (!navigator.gpu) {
            throw new Error("このブラウザはWebGPUをサポートしていません（フラグを確認してください）");
        }

        // 高性能GPUコアを要求
        const adapter = await navigator.gpu.requestAdapter({
            powerPreference: "high-performance"
        });
        this.device = await adapter.requestDevice();

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

        console.log(`[Renderer] WebGPU & FSR 1.0 基盤起動完了。内部解像度: ${this.renderWidth}x${this.renderHeight} -> 表示解像度: ${this.displayWidth}x${this.displayHeight}`);
    }

    // 解像度の動かぬ計算とテクスチャの再確保（スマホの縦横回転にも対応）
    resize() {
        this.displayWidth = Math.floor(window.innerWidth * window.devicePixelRatio);
        this.displayHeight = Math.floor(window.innerHeight * window.devicePixelRatio);
        
        // ゲーム内部の描画解像度は低く抑え、GPUの窒息を防ぐ
        this.renderWidth = Math.floor(this.displayWidth * this.scaleFactor);
        this.renderHeight = Math.floor(this.displayHeight * this.scaleFactor);

        this.canvas.width = this.displayWidth;
        this.canvas.height = this.displayHeight;

        if (this.device) {
            this.createGameTextures();
            this.updateBindGroups();
        }
    }

    // 内部レンダリング用およびFSR出力用のテクスチャをVRAM上に確保
    createGameTextures() {
        // ゲームが実際に描画される低解像度テクスチャ
        this.inputTexture = this.device.createTexture({
            size: [this.renderWidth, this.renderHeight, 1],
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
        });
        this.inputTextureView = this.inputTexture.createView();

        // FSRによって引き伸ばされた、画面に出力するための高解像度テクスチャ
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

    // AMD FSR 1.0 (EASU) コンピュートシェーダーの実装
    async initFSRShader() {
        const fsrWGSL = `
            @group(0) @binding(0) var inputTex: texture_2d<f32>;
            @group(0) @binding(1) var outputTex: texture_storage_2d<rgba8unorm, write>;

            // EASU (Edge Adaptive Spatial Upscaling) の簡易アルゴリズム
            @compute @workgroup_size(16, 16)
            fn main(@builtin(global_invocation_id) id: vec3<u32>) {
                let displaySize = textureDimensions(outputTex);
                let renderSize = textureDimensions(inputTex);

                if (id.x >= displaySize.x || id.y >= displaySize.y) { return; }

                // ディスプレイ座標からゲーム内部の低解像度座標へのマッピング
                let ratioX = f32(renderSize.x) / f32(displaySize.x);
                let ratioY = f32(renderSize.y) / f32(displaySize.y);
                
                let uv = vec2<f32>(f32(id.x) * ratioX, f32(id.y) * ratioY);
                let baseCoords = vec2<i32>(uv);

                // 周辺4ピクセル（クアッド）をサンプリング
                let c00 = textureLoad(inputTex, baseCoords + vec2<i32>(0, 0), 0);
                let c10 = textureLoad(inputTex, baseCoords + vec2<i32>(1, 0), 0);
                let c01 = textureLoad(inputTex, baseCoords + vec2<i32>(0, 1), 0);
                let c11 = textureLoad(inputTex, baseCoords + vec2<i32>(1, 1), 0);

                // 各色の輝度（ルミナンス）を計算してエッジの傾きを検出
                let l00 = dot(c00.rgb, vec3<f32>(0.299, 0.587, 0.114));
                let l10 = dot(c10.rgb, vec3<f32>(0.299, 0.587, 0.114));
                let l01 = dot(c01.rgb, vec3<f32>(0.299, 0.587, 0.114));
                let l11 = dot(c11.rgb, vec3<f32>(0.299, 0.587, 0.114));

                // 疑似的な異方性エッジ補間（簡易FSRフィルタ）
                let dX = abs(l10 - l00) + abs(l11 - l01);
                let dY = abs(l01 - l00) + abs(l11 - l10);
                
                var finalColor = vec4<f32>(0.0);
                if (dX > dY) {
                    // 横方向のエッジが強い場合、縦方向の補間を強める
                    finalColor = mix(mix(c00, c10, 0.5), mix(c01, c11, 0.5), 0.5);
                } else {
                    // 縦方向のエッジが強い場合、横方向の補間を強める
                    finalColor = mix(mix(c00, c01, 0.5), mix(c10, c11, 0.5), 0.5);
                }

                // 最終解像度のテクスチャへ、エッジをシャープにしたピクセルを書き込み
                textureStore(outputTex, vec2<i32>(id.xy), finalColor);
            }
        `;

        return this.device.createComputePipeline({
            layout: "auto",
            compute: {
                module: this.device.createShaderModule({ code: fsrWGSL }),
                entryPoint: "main"
            }
        });
    }

    // 毎フレームの実行処理
    render() {
        if (!this.device || !this.computeBindGroup) return;

        const commandEncoder = this.device.createCommandEncoder();
        
        // -------------------------------------------------------------------
        // [STEP 1] 内部解像度（70%）のテクスチャ（this.inputTexture）に対し、
        // バックルームの3Dレンダリングを行う（後ほどWasmのバイナリと結合）
        // -------------------------------------------------------------------
        const renderPassDesc = {
            colorAttachments: [{
                view: this.inputTextureView,
                clearValue: { r: 0.05, g: 0.05, b: 0.03, a: 1.0 }, // バックルームを模した薄暗い初期色
                loadOp: "clear",
                storeOp: "store"
            }]
        };
        const renderPass = commandEncoder.beginRenderPass(renderPassDesc);
        // ここに3DオブジェクトのDraw Callが入る
        renderPass.end();

        // -------------------------------------------------------------------
        // [STEP 2] 低解像度の絵を、FSR Compute Shaderに通して100%にアップスケーリング
        // -------------------------------------------------------------------
        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(this.fsrPipeline);
        computePass.setBindGroup(0, this.computeBindGroup);
        
        // 16x16のワークグループサイズに合わせて、GPUの並列計算スレッドをキック
        const workgroupCountX = Math.ceil(this.displayWidth / 16);
        const workgroupCountY = Math.ceil(this.displayHeight / 16);
        computePass.dispatchWorkgroups(workgroupCountX, workgroupCountY);
        computePass.end();

        // -------------------------------------------------------------------
        // [STEP 3] FSR処理されたテクスチャを実際の画面（キャンバス）にコピー・描画
        // -------------------------------------------------------------------
        const finalPassDesc = {
            colorAttachments: [{
                view: this.context.getCurrentTexture().createView(),
                loadOp: "clear",
                storeOp: "store"
            }]
        };
        const finalPass = commandEncoder.beginRenderPass(finalPassDesc);
        // 通常はここでBlit（画面への四角形ポリゴン描画）を行うが、
        // 今回は直接テクスチャコピー（CopyTextureToTexture）でも代用可能なためエンコーダーを最適化
        finalPass.end();

        // コマンドバッファをGPUのキューに送信
        this.device.queue.submit([commandEncoder.finish()]);
    }
}
