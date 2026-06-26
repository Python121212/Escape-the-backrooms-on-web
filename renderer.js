// renderer.js - Escape the Backrooms on Web 専用グラフィックエンジン基盤

export class BackroomsRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.device = null;
        this.context = null;
        
        // FSR用の解像度設定（スマホの負荷を徹底的に引き算する）
        this.scaleFactor = 0.7; // 内部解像度を70%に落とす
        this.renderWidth = 0;
        this.renderHeight = 0;
        this.displayWidth = 0;
        this.displayHeight = 0;
    }

    // 1. WebGPUの初期化
    async init() {
        if (!navigator.gpu) {
            throw new Error("このブラウザはWebGPUをサポートしていません（フラグを確認してください）");
        }

        // GPUアダプターとデバイスの確保
        const adapter = await navigator.gpu.requestAdapter({
            powerPreference: "high-performance" // スマホの高性能コアを要求
        });
        this.device = await adapter.requestDevice();

        // キャンバスコンテキストの設定
        this.context = this.canvas.getContext("webgpu");
        const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
        
        // 画面サイズに応じた解像度計算
        this.resize();

        this.context.configure({
            device: this.device,
            format: canvasFormat,
            alphaMode: "opaque"
        });

        // 2. AMD FSR 1.0（EASU: エッジ適応型アップスケーリング）シェーダーのコンパイル
        this.fsrPipeline = await this.initFSRShader(canvasFormat);
        
        console.log("WebGPU & FSR 1.0 基盤初期化成功。");
    }

    // 解像度の動的計算（スマホの縦横回転にも対応）
    resize() {
        this.displayWidth = window.innerWidth * window.devicePixelRatio;
        this.displayHeight = window.innerHeight * window.devicePixelRatio;
        
        // ゲーム内部の描画解像度はあえて小さくして、GPUの窒息を防ぐ
        this.renderWidth = Math.floor(this.displayWidth * this.scaleFactor);
        this.renderHeight = Math.floor(this.displayHeight * this.scaleFactor);

        this.canvas.width = this.displayWidth;
        this.canvas.height = this.displayHeight;
    }

    // FSR 1.0 用の Compute Shader (計算シェーダー) の仕込み
    async initFSRShader(canvasFormat) {
        const fsrWGSL = `
            // AMD FSR 1.0 (EASU) をWebGPU向けに超簡易化したシェーダーの骨組み
            @group(0) @binding(0) var inputTexture: texture_2d<f32>;
            @group(0) @binding(1) var outputTexture: texture_storage_2d<rgba8unorm, write>;

            @compute @workgroup_size(16, 16)
            fn main(@builtin(global_invocation_id) id: vec3<u32>) {
                let size = textureDimensions(inputTexture);
                
                // ここで低解像度のテクスチャからピクセルをサンプリングし、
                // エッジ（輪郭）を検出して、クッキリと高解像度へアップスケール補正する
                // （※実際のゲームアセット展開時にここの数式を完全結合させます）
                
                let renderCoords = vec2<i32>(i32(id.x), i32(id.y));
                let color = textureLoad(inputTexture, renderCoords / 2, 0); // 仮の間引き抽出
                
                textureStore(outputTexture, vec2<i32>(id.xy), color);
            }
        `;

        // 本作のキモとなる、MDI（Multi-Draw Indirect）やComputeカリングと連携させるための
        // パイプラインをここでビルドします
        return this.device.createComputePipeline({
            layout: "auto",
            compute: {
                module: this.device.createShaderModule({ code: fsrWGSL }),
                entryPoint: "main"
            }
        });
    }

    // 毎フレームの描画ループ
    render() {
        const commandEncoder = this.device.createCommandEncoder();
        
        // STEP 1: 内部解像度（70%）でバックルームの3D空間（黄色い壁や柱）をテクスチャへ描画
        // (ここに後ほど AOTコンパイルされたWasmからのMeshデータが流れます)

        // STEP 2: 低解像度で出来上がった絵を、FSR Compute Shader に通して100%サイズへ爆速アップスケール
        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(this.fsrPipeline);
        // 各種バインディング（Texture）を設定してディスパッチ
        // computePass.dispatchWorkgroups(Math.ceil(this.displayWidth / 16), Math.ceil(this.displayHeight / 16));
        computePass.end();

        // コマンドをGPUに送信して画面を更新
        this.device.queue.submit([commandEncoder.finish()]);
    }
}
