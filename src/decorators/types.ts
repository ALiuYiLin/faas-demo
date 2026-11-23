/**
 * 装饰器统一签名。
 *
 * 这里刻意用宽松的 `any`：目前只声明、不实现语义，所以不约束 target / context 的具体类型。
 * 同时把 `context` 设为可选，既能用于 TS 标准装饰器（默认，无需 experimentalDecorators），
 * 也能在开启 `experimentalDecorators` 的 legacy 模式下通过类型检查。
 */
export type DecoratorLike = (target: any, context?: any) => void;
