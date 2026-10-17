/*
 * Scribe — tipos mínimos de WebGPU (declaração global local ao módulo).
 *
 * Motivo: o `lib.dom` do TypeScript 5.9 **não** traz a WebGPU API e o projeto proíbe dependência
 * nova (`@webgpu/types` seria uma). Declaramos aqui apenas a superfície usada por
 * `webgpu-backend.ts`, no escopo global (arquivo de script, sem `import`/`export`).
 *
 * Sem `any`: tudo é estrutural e tipado. `skipLibCheck` está ligado no `tsconfig`.
 */

type GPUCanvasAlphaMode = "opaque" | "premultiplied";
type GPUTextureFormat = "rgba8unorm" | "bgra8unorm" | "rgba8unorm-srgb" | "bgra8unorm-srgb";
type GPUFilterMode = "nearest" | "linear";
type GPUAddressMode = "clamp-to-edge" | "repeat" | "mirror-repeat";
type GPUPrimitiveTopology = "point-list" | "line-list" | "line-strip" | "triangle-list" | "triangle-strip";
type GPULoadOp = "load" | "clear";
type GPUStoreOp = "store" | "discard";
type GPUBlendFactor =
  | "zero"
  | "one"
  | "src"
  | "one-minus-src"
  | "src-alpha"
  | "one-minus-src-alpha"
  | "dst"
  | "one-minus-dst"
  | "dst-alpha"
  | "one-minus-dst-alpha";
type GPUBlendOperation = "add" | "subtract" | "reverse-subtract" | "min" | "max";

interface GPUColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

type GPUExtent3D = number[] | { readonly width: number; readonly height: number; readonly depthOrArrayLayers?: number };

interface GPURequestAdapterOptions {
  readonly powerPreference?: "low-power" | "high-performance";
}

interface GPUAdapter {
  readonly __gpuAdapter: "GPUAdapter";
  requestDevice(descriptor?: GPUDeviceDescriptor): Promise<GPUDevice>;
}

interface GPUDeviceDescriptor {
  readonly label?: string;
  readonly requiredFeatures?: readonly string[];
  readonly requiredLimits?: Record<string, number>;
}

interface GPUBufferDescriptor {
  readonly label?: string;
  readonly size: number;
  readonly usage: number;
  readonly mappedAtCreation?: boolean;
}

interface GPUBuffer {
  readonly size: number;
  destroy(): void;
}

interface GPUTextureDescriptor {
  readonly label?: string;
  readonly size: GPUExtent3D;
  readonly format: GPUTextureFormat;
  readonly usage: number;
}

interface GPUTexture {
  createView(descriptor?: object): GPUTextureView;
  destroy(): void;
}

interface GPUTextureView {
  readonly __gpuTextureView: "GPUTextureView";
}

interface GPUTexelCopyBufferLayout {
  readonly offset?: number;
  readonly bytesPerRow?: number;
  readonly rowsPerImage?: number;
}

interface GPUTexelCopyTextureInfo {
  readonly texture: GPUTexture;
  readonly mipLevel?: number;
  readonly origin?: number[] | object;
  readonly aspect?: string;
}

interface GPUShaderModule {
  readonly __gpuShaderModule: "GPUShaderModule";
}

interface GPUShaderModuleDescriptor {
  readonly label?: string;
  readonly code: string;
}

interface GPUVertexState {
  readonly module: GPUShaderModule;
  readonly entryPoint: string;
}

interface GPUColorTargetState {
  readonly format: GPUTextureFormat;
  readonly blend?: GPUBlendState;
  readonly writeMask?: number;
}

interface GPUBlendComponent {
  readonly srcFactor?: GPUBlendFactor;
  readonly dstFactor?: GPUBlendFactor;
  readonly operation?: GPUBlendOperation;
}

interface GPUBlendState {
  readonly color: GPUBlendComponent;
  readonly alpha: GPUBlendComponent;
}

interface GPUFragmentState {
  readonly module: GPUShaderModule;
  readonly entryPoint: string;
  readonly targets: readonly GPUColorTargetState[];
}

interface GPUPrimitiveState {
  readonly topology?: GPUPrimitiveTopology;
}

interface GPURenderPipelineDescriptor {
  readonly label?: string;
  readonly layout: GPUPipelineLayout | "auto";
  readonly vertex: GPUVertexState;
  readonly fragment: GPUFragmentState;
  readonly primitive?: GPUPrimitiveState;
}

interface GPURenderPipeline {
  readonly __gpuRenderPipeline: "GPURenderPipeline";
}

interface GPUBufferBindingLayout {
  readonly type?: "uniform" | "storage" | "read-only-storage";
  readonly hasDynamicOffset?: boolean;
  readonly minBindingSize?: number;
}

interface GPUTextureBindingLayout {
  readonly sampleType?: "float" | "unfilterable-float" | "depth" | "sint" | "uint";
  readonly viewDimension?: "1d" | "2d" | "2d-array" | "cube" | "3d";
}

interface GPUSamplerBindingLayout {
  readonly type?: "filtering" | "non-filtering" | "comparison";
}

interface GPUBindGroupLayoutEntry {
  readonly binding: number;
  readonly visibility: number;
  readonly buffer?: GPUBufferBindingLayout;
  readonly texture?: GPUTextureBindingLayout;
  readonly sampler?: GPUSamplerBindingLayout;
}

interface GPUBindGroupLayout {
  readonly __gpuBindGroupLayout: "GPUBindGroupLayout";
}

interface GPUBindGroupLayoutDescriptor {
  readonly label?: string;
  readonly entries: readonly GPUBindGroupLayoutEntry[];
}

interface GPUPipelineLayout {
  readonly __gpuPipelineLayout: "GPUPipelineLayout";
}

interface GPUPipelineLayoutDescriptor {
  readonly label?: string;
  readonly bindGroupLayouts: readonly GPUBindGroupLayout[];
}

interface GPUSampler {
  readonly __gpuSampler: "GPUSampler";
}

interface GPUSamplerDescriptor {
  readonly label?: string;
  readonly addressModeU?: GPUAddressMode;
  readonly addressModeV?: GPUAddressMode;
  readonly addressModeW?: GPUAddressMode;
  readonly magFilter?: GPUFilterMode;
  readonly minFilter?: GPUFilterMode;
  readonly mipmapFilter?: GPUFilterMode;
}

interface GPUBufferBinding {
  readonly buffer: GPUBuffer;
  readonly offset?: number;
  readonly size?: number;
}

interface GPUBindGroupEntry {
  readonly binding: number;
  readonly resource: GPUBufferBinding | GPUSampler | GPUTextureView;
}

interface GPUBindGroup {
  readonly __gpuBindGroup: "GPUBindGroup";
}

interface GPUBindGroupDescriptor {
  readonly label?: string;
  readonly layout: GPUBindGroupLayout;
  readonly entries: readonly GPUBindGroupEntry[];
}

interface GPURenderPassColorAttachment {
  readonly view: GPUTextureView;
  readonly clearValue?: GPUColor;
  readonly loadOp?: GPULoadOp;
  readonly storeOp?: GPUStoreOp;
}

interface GPURenderPassDescriptor {
  readonly label?: string;
  readonly colorAttachments: readonly GPURenderPassColorAttachment[];
}

interface GPURenderPassEncoder {
  setPipeline(pipeline: GPURenderPipeline): void;
  setBindGroup(index: number, bindGroup: GPUBindGroup): void;
  setScissorRect(x: number, y: number, width: number, height: number): void;
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
  end(): void;
}

interface GPUCommandBuffer {
  readonly __gpuCommandBuffer: "GPUCommandBuffer";
}

interface GPUCommandEncoder {
  beginRenderPass(descriptor: GPURenderPassDescriptor): GPURenderPassEncoder;
  finish(): GPUCommandBuffer;
}

interface GPUQueue {
  writeBuffer(buffer: GPUBuffer, bufferOffset: number, data: ArrayBufferView): void;
  writeTexture(
    destination: GPUTexelCopyTextureInfo,
    data: ArrayBufferView,
    dataLayout: GPUTexelCopyBufferLayout,
    size: GPUExtent3D,
  ): void;
  submit(commandBuffers: readonly GPUCommandBuffer[]): void;
}

interface GPUDevice {
  readonly queue: GPUQueue;
  createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer;
  createTexture(descriptor: GPUTextureDescriptor): GPUTexture;
  createSampler(descriptor?: GPUSamplerDescriptor): GPUSampler;
  createShaderModule(descriptor: GPUShaderModuleDescriptor): GPUShaderModule;
  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): GPUBindGroupLayout;
  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): GPUPipelineLayout;
  createBindGroup(descriptor: GPUBindGroupDescriptor): GPUBindGroup;
  createRenderPipeline(descriptor: GPURenderPipelineDescriptor): GPURenderPipeline;
  createCommandEncoder(): GPUCommandEncoder;
  destroy(): void;
}

interface GPUCanvasConfiguration {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  readonly alphaMode?: GPUCanvasAlphaMode;
}

interface GPUCanvasContext {
  configure(configuration: GPUCanvasConfiguration): void;
  unconfigure(): void;
  getCurrentTexture(): GPUTexture;
}

interface GPU {
  requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter | null>;
  getPreferredCanvasFormat(): GPUTextureFormat;
}

declare const GPUBufferUsage: {
  readonly MAP_READ: number;
  readonly MAP_WRITE: number;
  readonly COPY_SRC: number;
  readonly COPY_DST: number;
  readonly INDEX: number;
  readonly VERTEX: number;
  readonly UNIFORM: number;
  readonly STORAGE: number;
};

declare const GPUTextureUsage: {
  readonly COPY_SRC: number;
  readonly COPY_DST: number;
  readonly TEXTURE_BINDING: number;
  readonly STORAGE_BINDING: number;
  readonly RENDER_ATTACHMENT: number;
};

declare const GPUShaderStage: {
  readonly VERTEX: number;
  readonly FRAGMENT: number;
  readonly COMPUTE: number;
};

declare const GPUMapMode: {
  readonly READ: number;
  readonly WRITE: number;
};

interface Navigator {
  readonly gpu?: GPU;
}

interface HTMLCanvasElement {
  getContext(contextId: "webgpu"): GPUCanvasContext | null;
}

interface OffscreenCanvas {
  getContext(contextId: "webgpu"): GPUCanvasContext | null;
}
