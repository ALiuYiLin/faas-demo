/** 用户状态 */
export type UserStatus = "active" | "disabled";

/** 用户实体：字段贴近真实业务，时间统一用 ISO 8601 字符串（方便直接 JSON 返回） */
export interface User {
  /** 业务主键，如 `u_3f9a1c2b` */
  id: string;
  name: string;
  email: string;
  status: UserStatus;
  /** 角色列表，如 `["admin", "user"]` */
  roles: string[];
  createdAt: string;
  updatedAt: string;
}

/** 创建用户的入参：id / 状态 / 时间戳由服务端生成 */
export interface CreateUserInput {
  name: string;
  email: string;
}
