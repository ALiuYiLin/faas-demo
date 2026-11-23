/**
 * 元数据层：装饰器只往这里写，容器 / 注册器只从这里读。
 *
 * 关键点：元数据按**类对象**（不是类名）存。每次重新求值 bundle 都会得到一个新类，
 * 天然区分「上一代」和「这一代」，重载时把旧类删掉即可，不需要额外的代际编号。
 */

export type HttpMethod = "get" | "post";

export interface RouteMeta {
  method: HttpMethod;
  path: string;
  handler: string | symbol;
}

export interface ParamMeta {
  kind: "param" | "body";
  index: number;
  /** @Param 的参数名，对应路由里的 `:name` */
  name?: string;
}

export interface InjectMeta {
  property: string | symbol;
  /** 显式指定的 bean 名；缺省用属性名 */
  ref?: string;
}

export interface ClassMeta {
  /** @Controller 的挂载路径；undefined 表示不是控制器 */
  path?: string;
  routes: RouteMeta[];
  injects: InjectMeta[];
  /** 参数装饰器先于方法装饰器执行，所以按 handler 单独存 */
  params: Map<string | symbol, ParamMeta[]>;
}

const classMetas = new Map<Function, ClassMeta>();

export function classMeta(type: Function): ClassMeta {
  let meta = classMetas.get(type);
  if (!meta) {
    meta = { routes: [], injects: [], params: new Map() };
    classMetas.set(type, meta);
  }
  return meta;
}

/** 丢弃某个类的元数据（重载后清理旧代） */
export function dropClassMeta(type: Function): void {
  classMetas.delete(type);
}

export function registerController(type: Function, path: string): void {
  classMeta(type).path = path;
  noteController(type);
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

/** 去掉 Impl 后缀 + 首字母小写：`UserServiceImpl` -> `userService` */
export function beanName(type: Function): string {
  const base = type.name.endsWith("Impl") ? type.name.slice(0, -"Impl".length) : type.name;
  return decapitalize(base || "anonymous");
}

function decapitalize(name: string): string {
  if (name === name.toUpperCase()) return name.toLowerCase();
  const head = /^[A-Z]+/.exec(name);
  if (!head) return name;
  if (head[0].length === 1) return name[0].toLowerCase() + name.slice(1);
  return head[0].slice(0, -1).toLowerCase() + name.slice(head[0].length - 1);
}

/* ------------------------------------------------------------------ *
 * 求值期捕获：执行一个 bundle 期间，记录它注册了哪些 bean / controller，
 * 运行时就靠这个知道"这个产物到底提供了什么"。
 * ------------------------------------------------------------------ */

export interface Registrations {
  beans: Array<{ name: string; type: Function }>;
  controllers: Function[];
}

let capture: Registrations | null = null;

export function beginCapture(): Registrations {
  capture = { beans: [], controllers: [] };
  return capture;
}

export function endCapture(): void {
  capture = null;
}

export function noteBean(name: string, type: Function): void {
  capture?.beans.push({ name, type });
}

export function noteController(type: Function): void {
  capture?.controllers.push(type);
}
