/**
 * `@faas/runtime` —— 热区模块唯一允许依赖的运行时。
 *
 * 构建期这个包是 external，bundle 里只保留 `require("@faas/runtime")`；
 * 运行期由沙箱的 require 映射回宿主这一份实例，所以装饰器写进的是宿主的元数据表。
 */
export { Controller } from "./decorators/controller";
export { Get, Post } from "./decorators/route";
export { Service } from "./decorators/service";
export { Resource } from "./decorators/resource";
export { Body, Param } from "./decorators/param";

export { controllerRouter } from "./controller";

export type { ResourceDecorator } from "./decorators/resource";
export type {
  ClassDecoratorLike,
  MethodDecoratorLike,
  ParameterDecoratorLike,
  PropertyDecoratorLike,
} from "./decorators/types";
