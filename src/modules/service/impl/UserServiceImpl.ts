import { randomUUID } from "node:crypto";
import { Service } from "@/decorators";
import type { CreateUserInput, User } from "@/modules/entity/User";
import { UserService } from "../UserService";

@Service()
export class UserServiceImpl implements UserService {
  // 示例数据，进程内存储；重启即重置
  private readonly users: User[] = [
    {
      id: "u_1001",
      name: "Tom",
      email: "tom@example.com",
      status: "active",
      roles: ["admin", "user"],
      createdAt: "2025-01-05T08:30:00.000Z",
      updatedAt: "2025-03-18T02:12:00.000Z",
    },
    {
      id: "u_1002",
      name: "Bob",
      email: "bob@example.com",
      status: "active",
      roles: ["user"],
      createdAt: "2025-02-11T09:05:00.000Z",
      updatedAt: "2025-02-11T09:05:00.000Z",
    },
  ];

  list(): User[] {
    return this.users;
  }

  find(id: string): User | undefined {
    return this.users.find((user) => user.id === id);
  }

  create(input: CreateUserInput): User {
    const now = new Date().toISOString();
    const user: User = {
      id: `u_${randomUUID().slice(0, 8)}`,
      name: input.name,
      email: input.email,
      status: "active",
      roles: ["user"],
      createdAt: now,
      updatedAt: now,
    };
    this.users.push(user);
    return user;
  }
}
