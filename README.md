# faas-demo

Minimal TypeScript + Express service with a single health endpoint.

## Scripts

```bash
npm run dev        # start with tsx watch
npm run build      # compile to dist/
npm start          # run compiled output
npm run typecheck  # type-check only
```

## Endpoint

| Method | Path      | Response         |
| ------ | --------- | ---------------- |
| GET    | `/health` | `{"status":"ok"}` |

Port defaults to `3000`, override with `PORT`.
