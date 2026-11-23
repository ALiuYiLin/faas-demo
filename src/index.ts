import express from "express";
import { HotLoader } from "./hot-loader.js";

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(port, () => {
  console.log(`listening on http://localhost:${port}`);
});


app.use('/api',async (req, res, next)=>{
  const loader = new HotLoader()
  await loader.init()
  const router = loader.getRouter()
  if (!router) {
    return res.status(503).json({ error: 'business module not ready' });
  }
  router(req, res, next)
})

