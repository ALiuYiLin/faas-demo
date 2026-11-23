import type { CreateUserInput, User } from "@/modules/entity/User";

export interface UserService {
  list(): User[];
  find(id: string): User | undefined;
  create(input: CreateUserInput): User;
}
