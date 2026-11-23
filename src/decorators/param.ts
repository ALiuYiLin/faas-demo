import { registerParam } from "@/runtime/context";
import type { ParameterDecoratorLike } from "./types";

/** 参数装饰器只能用在方法参数上；构造参数需要 constructor 注入，暂不支持 */
function assertMethodParam(propertyKey: string | symbol | undefined, decorator: string) {
  if (propertyKey === undefined) {
    throw new Error(`${decorator} 只能用在方法参数上（构造参数注入暂不支持）`);
  }
  return propertyKey;
}

/**
 * 注入路径参数（Express `req.params`）。
 *
 * ```ts
 * @Get("/detail/:id")
 * detail(@Param("id") id: string) { ... }
 * ```
 *
 * @param name 路由里的参数名，必须和 `:name` 一致
 */
export function Param(name: string): ParameterDecoratorLike {
  return (target, key, index) => {
    registerParam(target.constructor, assertMethodParam(key, "@Param"), {
      kind: "param",
      name,
      index,
    });
  };
}

/**
 * 注入请求体（`req.body`，需要 `express.json()` 中间件）。
 *
 * ```ts
 * @Post("/create")
 * create(@Body() dto: CreateUserDto) { ... }
 * ```
 */
export function Body(): ParameterDecoratorLike {
  return (target, key, index) => {
    registerParam(target.constructor, assertMethodParam(key, "@Body"), {
      kind: "body",
      index,
    });
  };
}