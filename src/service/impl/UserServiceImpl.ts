import { Service } from "../../decorators";
import { UserService } from "../UserService";

@Service()
export class UserServiceImpl implements UserService {
  list(): string[] {
    return ['tom','bob']
  }
}