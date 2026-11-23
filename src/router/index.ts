import { buildRouter } from "@/container";
import { UserController } from "@/modules/controller/UserController";
// 类型导入会被擦除，这里必须显式加载实现类，@Service 才会注册 bean
import "@/modules/service/impl/UserServiceImpl";

export default buildRouter({ controllers: [UserController] });
