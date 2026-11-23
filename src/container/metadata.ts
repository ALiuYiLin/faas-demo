/**
 * 元数据注册表：装饰器只往这里写，容器 / 路由注册器只从这里读。
 *
 * ⚠️ 本文件刻意不 import 任何项目内模块，避免和装饰器形成循环引用。
 */

export type HttpMethod = "get" | "post";

export interface RouteMeta {
  method: HttpMethod;
  path: string;
  /** 控制器上被装饰的方法名 */
  handler: string | symbol;
}

export interface InjectMeta {
  /** 被 @Resource 标注的属性名 */
  property: string | symbol;
  /** 显式指定的 bean 名；缺省用属性名 */
  ref?: string;
}

export type ParamKind = "param" | "body";

export interface ParamMeta {
  /** 参数来源：路径参数 / 请求体 */
  kind: ParamKind;
  /** 参数在方法签名里的位置 */
  index: number;
  /** @Param 的参数名，对应路由里的 `:name` */
  name?: string;
}

export interface ClassMeta {
  /** @Controller 的挂载路径；undefined 表示不是控制器 */
  path?: string;
  routes: RouteMeta[];
  injects: InjectMeta[];
  /**
   * handler -> 参数装饰器信息。
   * 参数装饰器先于方法装饰器执行，所以不能直接挂在 RouteMeta 上。
   */
  params: Map<string | symbol, ParamMeta[]>;
}

const classMetas = new Map<Function, ClassMeta>();
const beans = new Map<string, Function>();

/** 取（必要时创建）某个类的元数据。方法/属性装饰器先于类装饰器执行，所以这里可能先建。 */
export function classMeta(type: Function): ClassMeta {
  let meta = classMetas.get(type);
  if (!meta) {
    meta = { routes: [], injects: [], params: new Map() };
    classMetas.set(type, meta);
  }
  return meta;
}

export function registerController(type: Function, path: string): void {
  classMeta(type).path = path;
}

export function registerRoute(
  type: Function,
  method: HttpMethod,
  path: string,
  handler: string | symbol,
): void {
  classMeta(type).routes.push({ method, path, handler });
}

export function registerInject(type: Function, property: string | symbol, ref?: string): void {
  classMeta(type).injects.push({ property, ref });
}

/** 记录方法参数上的 @Param / @Body */
export function registerParam(
  type: Function,
  handler: string | symbol,
  param: ParamMeta,
): void {
  const params = classMeta(type).params;
  const list = params.get(handler) ?? [];
  list.push(param);
  params.set(handler, list);
}

/**
 * bean 命名约定：去掉 `Impl` 后缀 + 首字母小写。
 * `UserServiceImpl` -> `userService`，`UserService` -> `userService`。
 */
export function beanName(type: Function): string {
  const base = type.name.endsWith("Impl") ? type.name.slice(0, -"Impl".length) : type.name;
  return decapitalize(base || "anonymous");
}

/** `UserService` -> `userService`，`HTTPServer` -> `httpServer`，`URL` -> `url` */
function decapitalize(name: string): string {
  if (name === name.toUpperCase()) return name.toLowerCase();
  const head = /^[A-Z]+/.exec(name);
  if (!head) return name;
  if (head[0].length === 1) return name[0].toLowerCase() + name.slice(1);
  return head[0].slice(0, -1).toLowerCase() + name.slice(head[0].length - 1);
}

/** 注册 bean（@Service 在类定义时自动调用；mount 里也会兜底注册一次）。返回最终 bean 名。 */
export function registerBean(type: Function, name?: string): string {
  const resolved = name ?? beanName(type);
  const existing = beans.get(resolved);
  if (existing && existing !== type) {
    throw new Error(
      `[container] bean 名冲突："${resolved}" 已被 ${existing.name || "匿名类"} 占用，` +
        `${type.name || "匿名类"} 无法使用`,
    );
  }
  beans.set(resolved, type);
  return resolved;
}

export function getBean(name: string): Function | undefined {
  return beans.get(name);
}

export function beanNames(): string[] {
  return [...beans.keys()];
}

export function isRegisteredBean(type: Function): boolean {
  for (const registered of beans.values()) {
    if (registered === type) return true;
  }
  return false;
}

/** 已声明 @Controller 的类 -> 元数据 */
export function getControllers(): Map<Function, ClassMeta> {
  const result = new Map<Function, ClassMeta>();
  for (const [type, meta] of classMetas) {
    if (meta.path !== undefined) result.set(type, meta);
  }
  return result;
}

/** 清空注册表；热重载换"代"时用得上。 */
export function clearRegistry(): void {
  classMetas.clear();
  beans.clear();
}
