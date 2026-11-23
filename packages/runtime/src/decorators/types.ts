/**
 * 装饰器签名（legacy / experimentalDecorators 语义）。
 *
 * 用宽松的 `any` 是因为装饰器自身不参与业务类型推导，只负责把元数据写进注册表。
 */

/** 类装饰器：`@Controller("/users")`、`@Service()` */
export type ClassDecoratorLike = (target: any) => void;

/** 方法装饰器：`@Get("/list")`、`@Post("/create")`（legacy 下 target 是原型） */
export type MethodDecoratorLike = (
  target: any,
  propertyKey: string | symbol,
  descriptor?: any,
) => void;

/** 属性装饰器：`@Resource`、`@Resource("name")` */
export type PropertyDecoratorLike = (target: any, propertyKey: string | symbol) => void;

/** 参数装饰器：`@Param("id")`、`@Body()`（构造参数时 propertyKey 为 undefined） */
export type ParameterDecoratorLike = (
  target: any,
  propertyKey: string | symbol | undefined,
  parameterIndex: number,
) => void;
